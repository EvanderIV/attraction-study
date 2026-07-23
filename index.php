<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no">
<meta name="theme-color" content="#0b0f1e">
<title>The Attraction Study</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="assets/css/style.css?v=9">
</head>
<body>
  <!-- Animated gradient backdrop (parallax layers driven by JS) -->
  <div id="bg" aria-hidden="true">
    <div class="blob blob-a"></div>
    <div class="blob blob-b"></div>
    <div class="blob blob-c"></div>
    <div class="grain"></div>
  </div>

  <!-- Top chrome -->
  <header id="chrome">
    <div class="brand">Attraction<span>Study</span></div>
  </header>

  <!-- The card wheel -->
  <main id="stage">
    <div id="wheel" aria-live="polite"></div>
  </main>

  <!-- Navigation arrows -->
  <nav id="navdots">
    <button id="nav-prev" class="nav-arrow" aria-label="Previous question" type="button">
      <svg viewBox="0 0 24 24" width="22" height="22"><path d="M6 14l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <button id="nav-next" class="nav-arrow" aria-label="Next question" type="button">
      <svg viewBox="0 0 24 24" width="22" height="22"><path d="M6 10l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  </nav>

  <!-- Toast for gate messages -->
  <div id="toast" role="status" aria-live="polite"></div>

  <script src="assets/js/device-id.js?v=9"></script>
  <script src="assets/js/questions.js?v=9"></script>
  <script src="assets/js/app.js?v=9"></script>
</body>
</html>
