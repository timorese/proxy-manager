// Runs before first paint of the body: tab labels in the cached language (avoids an English flash for Russian users).
try {
  var l = localStorage.getItem('lang');
  if (l === 'ru' || (l !== 'en' && (navigator.language || '').toLowerCase().indexOf('ru') === 0)) {
    var names = { proxy: 'Прокси', pac: 'PAC', rules: 'Правила', settings: 'Настройки' };
    var tabs = document.querySelectorAll('.tabs button');
    for (var i = 0; i < tabs.length; i++) tabs[i].textContent = names[tabs[i].getAttribute('data-tab')];
  }
} catch (e) {}
