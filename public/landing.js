(() => {
  const ua = navigator.userAgent || '';
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  const isAndroid = /Android/.test(ua);
  if (isIOS) document.getElementById('ios-row').classList.add('highlight');
  if (isAndroid) document.getElementById('android-row').classList.add('highlight');
})();
