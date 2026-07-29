import './manager.css';

/** Every user-facing string lives in `_locales/en/messages.json`; the markup only names them. */
function localize(root: ParentNode): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = element.dataset['i18n'];
    if (key !== undefined) element.textContent = chrome.i18n.getMessage(key);
  }
}

localize(document);
