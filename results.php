<?php
/**
 * Minimal aggregate results viewer.
 * Access: results.php?key=YOUR_KEY   (change ADMIN_KEY before deploying!)
 * Add &export=csv to download raw rows.
 */

declare(strict_types=1);

const ADMIN_KEY = 'change-me-before-deploy';
const DB_FILE = __DIR__ . '/data/responses.sqlite';

if (!hash_equals(ADMIN_KEY, (string)($_GET['key'] ?? ''))) {
    http_response_code(403);
    exit('Forbidden');
}
if (!file_exists(DB_FILE)) {
    exit('No responses yet.');
}

$pdo = new PDO('sqlite:' . DB_FILE, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);

if (($_GET['export'] ?? '') === 'csv') {
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="responses.csv"');
    $out = fopen('php://output', 'w');
    fputcsv($out, ['id', 'created_at', 'sex', 'orientation', 'target_sex', 'answers_json', 'meta_json']);
    foreach ($pdo->query('SELECT id, created_at, sex, orientation, target_sex, answers_json, meta_json FROM responses ORDER BY id') as $row) {
        fputcsv($out, $row);
    }
    exit;
}

$total = (int) $pdo->query('SELECT COUNT(*) FROM responses')->fetchColumn();
$bySex = $pdo->query('SELECT sex, orientation, COUNT(*) n FROM responses GROUP BY sex, orientation ORDER BY n DESC')->fetchAll(PDO::FETCH_ASSOC);

// Average the numeric answers per question, grouped by target sex.
$agg = [];
foreach ($pdo->query('SELECT target_sex, answers_json FROM responses') as $row) {
    $ans = json_decode($row['answers_json'], true) ?: [];
    foreach ($ans as $qid => $val) {
        if (is_numeric($val)) {
            $agg[$qid][$row['target_sex']]['sum'] = ($agg[$qid][$row['target_sex']]['sum'] ?? 0) + $val;
            $agg[$qid][$row['target_sex']]['n']   = ($agg[$qid][$row['target_sex']]['n'] ?? 0) + 1;
        } elseif (is_array($val)) {
            foreach ($val as $k => $v) {
                if (is_numeric($v)) {
                    $key = $qid . '.' . $k;
                    $agg[$key][$row['target_sex']]['sum'] = ($agg[$key][$row['target_sex']]['sum'] ?? 0) + $v;
                    $agg[$key][$row['target_sex']]['n']   = ($agg[$key][$row['target_sex']]['n'] ?? 0) + 1;
                }
            }
        }
    }
}
ksort($agg);

function h(?string $s): string { return htmlspecialchars((string)$s, ENT_QUOTES); }
?>
<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Attraction Study — Results</title>
<style>
  body { font-family: system-ui, sans-serif; background: #10142a; color: #eef; padding: 2rem; max-width: 900px; margin: auto; }
  h1 { font-weight: 600; } h2 { margin-top: 2rem; font-size: 1.05rem; color: #9fb0ff; }
  table { border-collapse: collapse; width: 100%; margin-top: 0.6rem; font-size: 0.9rem; }
  th, td { text-align: left; padding: 0.45rem 0.7rem; border-bottom: 1px solid #2a3155; }
  th { color: #8892c0; font-weight: 600; }
  a { color: #7fd4ff; }
  .big { font-size: 2.4rem; font-weight: 700; }
</style></head><body>
<h1>Attraction Study — Results</h1>
<div class="big"><?= $total ?></div><div>total responses · <a href="?key=<?= h($_GET['key']) ?>&export=csv">export CSV</a></div>

<h2>Respondents by sex &amp; orientation</h2>
<table><tr><th>Sex</th><th>Orientation</th><th>Count</th></tr>
<?php foreach ($bySex as $r): ?>
<tr><td><?= h($r['sex']) ?></td><td><?= h($r['orientation']) ?></td><td><?= (int)$r['n'] ?></td></tr>
<?php endforeach; ?>
</table>

<h2>Average numeric ratings (by target sex of attraction)</h2>
<table><tr><th>Question / part</th><th>Target: Male</th><th>Target: Female</th></tr>
<?php foreach ($agg as $qid => $groups): ?>
<tr>
  <td><?= h($qid) ?></td>
  <?php foreach (['Male', 'Female'] as $t):
      $g = $groups[$t] ?? null; ?>
  <td><?= $g ? number_format($g['sum'] / $g['n'], 2) . ' <small>(n=' . $g['n'] . ')</small>' : '—' ?></td>
  <?php endforeach; ?>
</tr>
<?php endforeach; ?>
</table>
</body></html>
