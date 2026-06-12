(function () {
  var path = location.pathname
  var lang = document.documentElement.lang === 'en' ? 'en' : 'zh-Hant'
  var stored = null
  try { stored = localStorage.getItem('lang') } catch (e) {}
  var suffix = location.search + location.hash
  if (path === '/' || path === '/en') {
    if (stored === 'en' && lang !== 'en') {
      location.replace('/en' + suffix)
      return
    }
    if (stored === 'zh-Hant' && lang === 'en') {
      location.replace('/' + suffix)
      return
    }
  }
  function persist (e) {
    var t = e.target && e.target.closest && e.target.closest('#lang-switch')
    if (!t) return
    try { localStorage.setItem('lang', t.getAttribute('data-lang') || '') } catch (err) {}
  }
  document.addEventListener('click', persist)
  document.addEventListener('auxclick', persist)
})()
