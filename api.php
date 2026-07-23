<?php
/**
 * The Attraction Study — API
 *
 * Actions (POST, JSON body):
 *   ?action=check   {fingerprint:{device,browser}}          -> {submitted:bool}
 *   ?action=submit  {fingerprint, profile, answers, meta}   -> {ok:true} | {error:"duplicate"}
 *
 * Storage: SQLite in data/responses.sqlite (auto-created).
 * Dedup: UNIQUE constraint on the device fingerprint hash, plus a salted
 * IP+UA hash kept as a secondary signal for later analysis.
 */

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

const DATA_DIR = __DIR__ . '/data';
const DB_FILE  = DATA_DIR . '/responses.sqlite';
const IP_SALT  = 'attraction-study-2026-salt-v1'; // rotate to invalidate ip hashes

function respond(array $payload, int $code = 200): never {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

function fail(string $error, int $code = 400): never {
    respond(['ok' => false, 'error' => $error], $code);
}

function db(): PDO {
    static $pdo = null;
    if ($pdo === null) {
        if (!is_dir(DATA_DIR)) {
            mkdir(DATA_DIR, 0755, true);
        }
        // Belt-and-braces: block direct web access to the data dir on Apache.
        $ht = DATA_DIR . '/.htaccess';
        if (!file_exists($ht)) {
            file_put_contents($ht, "Require all denied\n");
        }
        $pdo = new PDO('sqlite:' . DB_FILE, null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        ]);
        $pdo->exec('PRAGMA journal_mode = WAL');
        $pdo->exec('PRAGMA busy_timeout = 3000');
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS responses (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                device_fp     TEXT NOT NULL UNIQUE,
                browser_fp    TEXT,
                ip_hash       TEXT,
                sex           TEXT,
                orientation   TEXT,
                target_sex    TEXT,
                answers_json  TEXT NOT NULL,
                meta_json     TEXT,
                created_at    TEXT NOT NULL DEFAULT (datetime('now'))
            )
        ");
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_ip ON responses (ip_hash)');
    }
    return $pdo;
}

function clientIpHash(): string {
    $ip = $_SERVER['REMOTE_ADDR'] ?? '';
    return hash('sha256', IP_SALT . '|' . $ip);
}

/** Validate a client-supplied fingerprint hash: hex, sane length. */
function cleanHash(mixed $v): ?string {
    if (!is_string($v)) return null;
    $v = strtolower(trim($v));
    if (!preg_match('/^[0-9a-f]{16,128}$/', $v)) return null;
    return $v;
}

/* ---------- Aggregate statistics helpers -------------------------------- */

/** Question ids whose answer distributions are shared with clients. */
function statWhitelisted(string $qid): bool {
    if (preg_match('/^(l_|v_|p_)/', $qid)) return true;
    return in_array($qid, [
        'looks_importance', 'fitness_importance', 'intelligence_importance',
        'looks_vs_personality', 'first_notice', 'single_feature',
        'humor_style', 'height_pref', 'logic_emotion',
    ], true);
}

/** Mean of available items, with reverse-coded items inverted on a 1-5 scale. */
function scoreMean(array $answers, array $items, array $reverse = []): ?float {
    $vals = [];
    foreach ($items as $id) {
        if (isset($answers[$id]) && is_numeric($answers[$id])) {
            $v = (float) $answers[$id];
            $vals[] = in_array($id, $reverse, true) ? 6 - $v : $v;
        }
    }
    if (count($vals) < 2 && count($items) > 1) return null;
    if (count($vals) === 0) return null;
    return array_sum($vals) / count($vals);
}

/** Behavior / expectation indices used for correlation pairs. */
function derivedScores(array $answers): array {
    return [
        'selfishness' => scoreMean($answers,
            ['v_m_effort', 'v_m_league', 'v_m_trophy', 'v_m_win', 'v_m_work',
             'v_f_spoiled', 'v_f_mindread', 'v_f_status', 'v_f_effortless', 'v_f_boredom'],
            ['v_m_work', 'v_f_boredom']),
        'expectations' => scoreMean($answers, ['l_gifts', 'l_my_spending', 'l_obedience']),
        'extraversion' => scoreMean($answers, ['p_social_energy', 'p_ideal_weekend']),
        'looks'        => isset($answers['looks_importance']) && is_numeric($answers['looks_importance'])
                            ? (float) $answers['looks_importance'] : null,
        'communication'=> isset($answers['l_communication']) && is_numeric($answers['l_communication'])
                            ? (float) $answers['l_communication'] : null,
    ];
}

/* ---------- Public fantasy moderation ------------------------------------
   Applied at READ time so the ruleset can evolve without touching stored
   data. Normalization defeats common evasion: leetspeak (f4gg0t), spacing
   and punctuation (f.u.c.k / f u c k), repeated letters (fuuuck), and
   diacritics. This is a starter list — swap in a maintained blocklist for
   scale. Base tier = PG-13 (slurs, explicit sexual content, contact info).
   Strict tier (r=cn audiences) adds profanity + BDSM references.        */

/** True if any haystack contains any needle as a substring. */
function containsAny(array $hays, array $words): bool {
    foreach ($words as $w) {
        foreach ($hays as $h) {
            if (str_contains($h, $w)) return true;
        }
    }
    return false;
}

/** True if any token in the padded token string matches a whole word,
 *  or any spaced-letter cluster contains the word as a substring. */
function containsWord(string $padded, array $words, string $clusters = ''): bool {
    foreach ($words as $w) {
        if (str_contains($padded, ' ' . $w . ' ')) return true;
        if ($clusters !== '' && str_contains($clusters, $w)) return true;
    }
    return false;
}

function fantasyAllowed(string $t, bool $strict): bool {
    // Contact info first, on the RAW text (leet-folding would eat digits):
    // 7+ digits total anywhere = phone number, however it's separated.
    if (strlen(preg_replace('/\D+/', '', $t)) >= 7) return false;
    if (preg_match('/@[\w.]{3,}/u', $t)) return false;          // @handles / emails

    $s = mb_strtolower($t, 'UTF-8');
    if (function_exists('iconv')) {
        $tr = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s);   // strip diacritics
        if ($tr !== false && $tr !== '') $s = strtolower($tr);
    }
    // Fold leetspeak.
    $s = strtr($s, ['0'=>'o','1'=>'i','3'=>'e','4'=>'a','5'=>'s','7'=>'t','8'=>'b','$'=>'s','@'=>'a','!'=>'i','|'=>'i','+'=>'t']);

    $sq  = preg_replace('/[^a-z]+/', '', $s);                   // squashed: beats spacing
    $sqc = preg_replace('/(.)\1+/', '$1', $sq);                 // runs collapsed: beats "fuuuck"
    $hay = [$sq, $sqc];
    $sp  = ' ' . trim(preg_replace('/[^a-z]+/', ' ', $s)) . ' ';// tokenized: for short words
    // Runs of single-letter tokens squashed ("such a w h o r e" -> "awhore").
    // Word-bounded checks run on normal tokens; SUBSTRING checks run inside
    // these clusters — they only exist when letters were deliberately spaced,
    // so substring matching there can't hit "who reads"-style collisions.
    $clusters = '';
    if (preg_match_all('/(?: [a-z]){2,}(?= )/', $sp, $mm)) {
        $clusters = str_replace(' ', '', implode('|', $mm[0]));
    }

    // Links & social handles. Short/collision-prone terms ("insta" is inside
    // "instantly", "www" inside "awww") are word-bounded; the rest substring.
    if (containsAny($hay, ['http', 'dotcom', 'instagram', 'snapchat',
        'onlyfans', 'fansly', 'telegram', 'whatsapp', 'tiktok', 'discord', 'linktree',
        'kikme', 'addme', 'dmme'])) return false;
    if (containsWord($sp, ['www', 'insta', 'kik'], $clusters)) return false;

    // Slurs — regex with letter-repeat tolerance on the squashed text.
    foreach (['/n+i+g+g+(e+r+|a+)/', '/f+a+g+g*o+t+/', '/r+e+t+a+r+d/', '/t+r+a+n+n+(y+|i+e*)/',
              '/c+h+i+n+k+/', '/w+e+t+b+a+c+k+/', '/b+e+a+n+e+r+/'] as $re) {
        if (preg_match($re, $sq) || preg_match($re, $sqc)) return false;
    }
    if (containsWord($sp, ['kike', 'spic', 'spick', 'dyke', 'fag', 'fags'], $clusters)) return false;

    // Explicit sexual content: long unambiguous terms as substrings…
    if (containsAny($hay, ['blowjob', 'handjob', 'rimjob', 'deepthroat', 'gangbang',
        'creampie', 'fisting', 'squirting', 'cumshot', 'bukkake', 'pegging', 'dildo',
        'buttplug', 'hentai', 'porn', 'milf', 'nudes', 'sexting'])) return false;
    // …short/ambiguous terms only as whole words (avoids peacock, circumstance…).
    if (containsWord($sp, ['anal', 'cum', 'cock', 'dick', 'pussy', 'cunt', 'tits', 'boobs'], $clusters)) return false;

    if ($strict) {
        // "whore" must be word-bounded: squashed "who reads" contains it.
        if (containsAny($hay, ['fuck', 'shit', 'bitch', 'bastard', 'goddamn',
            'motherfuck', 'slut', 'piss'])) return false;
        if (containsWord($sp, ['ass', 'asses', 'asshole', 'damn', 'crap', 'hoe', 'hoes', 'whore', 'whores'], $clusters)) return false;
        if (containsAny($hay, ['bdsm', 'bondage', 'dominatrix', 'submissive', 'shibari',
            'fetish', 'kink', 'spank', 'choke', 'choking', 'sadis', 'masochis', 'domme',
            'handcuff', 'blindfold', 'leash', 'degrad'])) return false;
    }
    return true;
}

/** Pearson r + least-squares fit. Returns null when degenerate. */
function pearson(array $xs, array $ys): ?array {
    $n = count($xs);
    if ($n < 3) return null;
    $mx = array_sum($xs) / $n;
    $my = array_sum($ys) / $n;
    $sxy = $sxx = $syy = 0.0;
    for ($i = 0; $i < $n; $i++) {
        $dx = $xs[$i] - $mx;
        $dy = $ys[$i] - $my;
        $sxy += $dx * $dy;
        $sxx += $dx * $dx;
        $syy += $dy * $dy;
    }
    if ($sxx == 0.0 || $syy == 0.0) return null;
    $r = $sxy / sqrt($sxx * $syy);
    $slope = $sxy / $sxx;
    return [
        'r' => round($r, 3),
        'slope' => round($slope, 4),
        'intercept' => round($my - $slope * $mx, 4),
        'n' => $n,
    ];
}

// CLI test harnesses can include this file for its functions only.
if (PHP_SAPI === 'cli' && defined('STUDY_API_TEST')) {
    return;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail('method_not_allowed', 405);
}

// Deployment self-check: POST api.php?action=diag (no body needed).
// Reports environment booleans only — safe to leave enabled.
if (($_GET['action'] ?? '') === 'diag') {
    $dbOpen = false;
    $dbError = null;
    try {
        db();
        $dbOpen = true;
    } catch (Throwable $e) {
        $dbError = $e->getMessage();
    }
    respond([
        'ok' => true,
        'php' => PHP_VERSION,
        'php_ok' => PHP_VERSION_ID >= 80100,
        'pdo_sqlite_loaded' => extension_loaded('pdo_sqlite'),
        'data_dir_exists' => is_dir(DATA_DIR),
        'data_dir_writable' => is_dir(DATA_DIR) ? is_writable(DATA_DIR) : is_writable(__DIR__),
        'db_openable' => $dbOpen,
        'db_error' => $dbError,
        'server_user_can_write_db' => file_exists(DB_FILE) ? is_writable(DB_FILE) : null,
    ]);
}

$raw = file_get_contents('php://input');
if ($raw === false || strlen($raw) > 64 * 1024) {
    fail('bad_request');
}
$body = json_decode($raw, true);
if (!is_array($body)) {
    fail('bad_json');
}

$action   = $_GET['action'] ?? '';
$deviceFp = cleanHash($body['fingerprint']['device'] ?? null);
$browserFp = cleanHash($body['fingerprint']['browser'] ?? null);

if ($deviceFp === null) {
    fail('missing_fingerprint');
}

try {
    switch ($action) {
        case 'check': {
            $stmt = db()->prepare('SELECT 1 FROM responses WHERE device_fp = ? LIMIT 1');
            $stmt->execute([$deviceFp]);
            respond(['ok' => true, 'submitted' => (bool) $stmt->fetchColumn()]);
        }

        case 'submit': {
            $answers = $body['answers'] ?? null;
            if (!is_array($answers) || $answers === []) {
                fail('missing_answers');
            }
            if (isset($answers['fantasy']) && is_string($answers['fantasy'])) {
                $answers['fantasy'] = mb_substr(trim($answers['fantasy']), 0, 300);
            }
            // Minimal server-side sanity on the profile fields we aggregate by.
            $profile = is_array($body['profile'] ?? null) ? $body['profile'] : [];
            $sex     = in_array($profile['sex'] ?? '', ['Male', 'Female'], true) ? $profile['sex'] : null;
            $orient  = in_array($profile['orientation'] ?? '', ['Straight', 'Homosexual', 'Pansexual', 'Bisexual'], true) ? $profile['orientation'] : null;
            $target  = in_array($profile['targetSex'] ?? '', ['Male', 'Female'], true) ? $profile['targetSex'] : null;
            if ($sex === null || $orient === null || $target === null) {
                fail('missing_profile');
            }

            $meta = is_array($body['meta'] ?? null) ? $body['meta'] : [];

            try {
                $stmt = db()->prepare('
                    INSERT INTO responses
                        (device_fp, browser_fp, ip_hash, sex, orientation, target_sex, answers_json, meta_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ');
                $stmt->execute([
                    $deviceFp,
                    $browserFp,
                    clientIpHash(),
                    $sex,
                    $orient,
                    $target,
                    json_encode($answers, JSON_UNESCAPED_UNICODE),
                    json_encode($meta, JSON_UNESCAPED_UNICODE),
                ]);
            } catch (PDOException $e) {
                // 23000 = constraint violation -> same device already submitted
                if ($e->getCode() === '23000' || str_contains($e->getMessage(), 'UNIQUE')) {
                    respond(['ok' => false, 'error' => 'duplicate'], 409);
                }
                throw $e;
            }
            respond(['ok' => true]);
        }

        case 'stats': {
            // Personalized aggregates: caller must have a submitted response.
            $strict = !empty($body['strict']);
            $stmt = db()->prepare('SELECT sex, answers_json FROM responses WHERE device_fp = ? LIMIT 1');
            $stmt->execute([$deviceFp]);
            $me = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($me === false) {
                fail('not_found', 404);
            }
            $myAnswers = json_decode((string) $me['answers_json'], true) ?: [];
            $mySex = $me['sex'];
            // Strict applies to Christian respondents however that was
            // established — self-selected answer, r=cn preset, or the
            // client-sent flag. Server-side check is authoritative.
            if (($myAnswers['religion'] ?? null) === 'Christian') {
                $strict = true;
            }

            $dist = [];          // qid -> value -> count (whitelisted only)
            $pairData = [
                'self_expect' => ['xs' => [], 'ys' => []],
                'self_looks'  => ['xs' => [], 'ys' => []],
                'extra_comm'  => ['xs' => [], 'ys' => []],
            ];
            $pairAxes = [
                'self_expect' => ['selfishness', 'expectations'],
                'self_looks'  => ['selfishness', 'looks'],
                'extra_comm'  => ['extraversion', 'communication'],
            ];

            $myScores = derivedScores($myAnswers);

            $total = 0;
            $fanCands = [];   // public fantasies from same-sex respondents
            foreach (db()->query('SELECT device_fp, sex, orientation, answers_json FROM responses') as $row) {
                $ans = json_decode($row['answers_json'], true);
                if (!is_array($ans)) continue;
                $total++;
                foreach ($ans as $qid => $val) {
                    if (!statWhitelisted((string) $qid)) continue;
                    if (is_numeric($val) || is_string($val)) {
                        $key = (string) $val;
                        $dist[$qid][$key] = ($dist[$qid][$key] ?? 0) + 1;
                    }
                }
                $scores = derivedScores($ans);
                foreach ($pairAxes as $pid => [$xk, $yk]) {
                    if ($scores[$xk] !== null && $scores[$yk] !== null) {
                        $pairData[$pid]['xs'][] = round($scores[$xk], 2);
                        $pairData[$pid]['ys'][] = round($scores[$yk], 2);
                    }
                }

                // Fantasy candidates: not mine, same biological sex, consented
                // public, (strict: straight respondents only), passes filter.
                if ($row['device_fp'] === $deviceFp) continue;
                if ($row['sex'] !== $mySex) continue;
                if (($ans['fantasy_public'] ?? true) === false) continue;
                if ($strict && $row['orientation'] !== 'Straight') continue;
                $ft = $ans['fantasy'] ?? null;
                if (!is_string($ft) || mb_strlen(trim($ft)) < 3) continue;
                $ft = mb_substr(trim($ft), 0, 200);
                if (!fantasyAllowed($ft, $strict)) continue;
                // "Similar" = closest on the derived behavior scores.
                $d = 0.0; $k = 0;
                foreach (['selfishness', 'extraversion', 'looks'] as $sk) {
                    if ($scores[$sk] !== null && $myScores[$sk] !== null) {
                        $d += abs($scores[$sk] - $myScores[$sk]);
                        $k++;
                    }
                }
                $fanCands[] = ['d' => $k ? $d / $k : 9.0, 't' => $ft];
            }
            usort($fanCands, fn($a, $b) => $a['d'] <=> $b['d']);
            $fantasies = array_column(array_slice($fanCands, 0, 6), 't');
            $pairs = [];
            foreach ($pairAxes as $pid => [$xk, $yk]) {
                $xs = $pairData[$pid]['xs'];
                $ys = $pairData[$pid]['ys'];
                $fit = pearson($xs, $ys);
                // Cap scatter payload; the fit is computed over ALL points.
                if (count($xs) > 250) {
                    $keys = array_rand(array_flip(range(0, count($xs) - 1)), 250);
                    $xs = array_values(array_intersect_key($xs, array_flip((array) $keys)));
                    $ys = array_values(array_intersect_key($ys, array_flip((array) $keys)));
                }
                $points = [];
                foreach ($xs as $i => $x) $points[] = [$x, $ys[$i]];
                $pairs[$pid] = [
                    'fit' => $fit,
                    'points' => $points,
                    'you' => ($myScores[$xk] !== null && $myScores[$yk] !== null)
                        ? [round($myScores[$xk], 2), round($myScores[$yk], 2)] : null,
                ];
            }

            respond(['ok' => true, 'n' => $total, 'dist' => $dist, 'pairs' => $pairs, 'fantasies' => $fantasies]);
        }

        default:
            fail('unknown_action', 404);
    }
} catch (Throwable $e) {
    error_log('[attraction-study] ' . $e->getMessage());
    fail('server_error', 500);
}
