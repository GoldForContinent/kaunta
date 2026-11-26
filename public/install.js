/* Kaunta PWA install helper — one place for phone/browser-specific guidance.
   Loaded synchronously in <head> so every install button can use it immediately. */
(function () {
  var ua = navigator.userAgent || '';
  var android = /Android/i.test(ua);
  var ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  var miui = /MiuiBrowser|MIUI|Redmi|Xiaomi|POCO/i.test(ua);
  var samsung = /SamsungBrowser/i.test(ua);
  var uc = /UCBrowser|UCBrowserHD/i.test(ua);
  var opera = /OPR\/|Opera Mini|Opera\//i.test(ua);
  var firefox = /Firefox\//i.test(ua) && !ios;
  var chrome = (/Chrome\/|CriOS\//i.test(ua) && !opera) || /EdgA\//i.test(ua);

  function guide() {
    if (ios) {
      return {
        key: 'ios',
        title: 'Install Kaunta on iPhone / iPad',
        note: 'Use Safari for the most reliable install. Chrome for iOS uses the same Share menu.',
        steps: [
          'Tap the Share box — a square with an arrow — at the bottom of the screen.',
          'Tap “Add to Home Screen”.',
          'Tap “Add” in the top-right, then wait for the Kaunta icon.'
        ]
      };
    }
    if (miui) {
      return {
        key: 'miui',
        title: 'Install Kaunta on Redmi / Xiaomi',
        note: 'On some Redmi A05 phones Chrome hides “Install app”. That is a phone/Chrome limitation, not Kaunta. The home-screen shortcut still works.',
        steps: [
          'In Chrome tap the ⋮ menu. If you see “Install app”, tap it.',
          'If there is no install option, tap “Share”, then “Add to Home screen”.',
          'Confirm “Add”. If the icon lands in the app drawer, drag it to your home screen.'
        ]
      };
    }
    if (samsung) {
      return {
        key: 'samsung',
        title: 'Install Kaunta on Samsung Internet',
        note: 'Samsung Internet installs Kaunta like a normal app — no Play Store download needed.',
        steps: [
          'Tap the ⋮ menu in Samsung Internet.',
          'Tap “Add page to”, then “Home screen” (or “Install app”).',
          'Confirm “Add” / “Install”.'
        ]
      };
    }
    if (uc) {
      return {
        key: 'uc',
        title: 'Install Kaunta from UC Browser',
        note: 'UC Browser can add a home-screen shortcut. For full offline use, open the site in Chrome.',
        steps: [
          'Tap the ≡ menu, then “Add to Home screen”.',
          'Confirm “Add”.',
          'If you only get a plain shortcut, use the Chrome button below.'
        ]
      };
    }
    if (opera) {
      return {
        key: 'opera',
        title: 'Install Kaunta from Opera',
        note: 'Opera’s menu has an install option on most Android phones. If it is missing, use Chrome.',
        steps: [
          'Tap the Opera menu (the O or ⋮ button).',
          'Tap “Add to Home screen” or “Install app”.',
          'Confirm “Add”.'
        ]
      };
    }
    if (firefox) {
      return {
        key: 'firefox',
        title: 'Install Kaunta from Firefox',
        note: 'Firefox may only create a shortcut in some versions. Chrome gives the full offline Kaunta app.',
        steps: [
          'Tap the ⋮ menu, then “Add to Home screen”.',
          'Confirm “Add”.',
          'If it behaves like a plain bookmark, use the Chrome button below.'
        ]
      };
    }
    if (chrome) {
      return {
        key: 'chrome',
        title: 'Install Kaunta from Chrome',
        note: 'Chrome handles the install prompt automatically on most Android phones.',
        steps: [
          'Tap the ⋮ menu in Chrome.',
          'Tap “Install app” — older Chrome calls it “Add to Home screen”.',
          'Tap “Install” on the pop-up.'
        ]
      };
    }
    return {
      key: 'generic',
      title: 'Install Kaunta on this phone',
      note: 'Every mainstream phone browser can add Kaunta to the home screen. If your menu has no install option, use “Share → Add to Home screen”.',
      steps: [
        'Open your browser menu — usually ⋮ or ≡.',
        'Tap “Install app” if it is there; otherwise tap “Share → Add to Home screen”.',
        'Confirm “Add”, then open Kaunta from your home screen or app drawer.'
      ]
    };
  }

  // Android intent opens this same page in Chrome. If Chrome is missing, the
  // fallback URL takes the customer to the Play Store instead of a blank screen.
  function openInChromeUrl() {
    if (!android || ios) return '';
    var bare = location.href.split('#')[0].replace(/^https?:\/\//, '');
    var scheme = location.protocol === 'https:' ? 'https' : 'http';
    return 'intent://' + bare + '#Intent;scheme=' + scheme +
      ';package=com.android.chrome;S.browser_fallback_url=' +
      encodeURIComponent('https://play.google.com/store/apps/details?id=com.android.chrome') + ';end';
  }

  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      navigator.standalone === true;
  }

  window.KauntaInstall = {
    guide: guide,
    openInChromeUrl: openInChromeUrl,
    isStandalone: isStandalone,
    ua: ua
  };
})();
