import { connectFirebase, authError } from './firebase.js';
import { categories, priorities, dateKey, localDate, validDate, validTime, calendarFile } from './model.js';

const $ = id => document.getElementById(id);
const paths = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
  moon: '<path d="M20 15a8 8 0 0 1-11-11A9 9 0 1 0 20 15Z"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 16v4h16v-4"/>',
  camera: '<path d="M3 7h4l2-3h6l2 3h4v13H3z"/><circle cx="12" cy="13" r="4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-4 3 3 5-6 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12 5 5L19 8"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>'
};
function icon(name) {
  const span = document.createElement('span');
  span.dataset.icon = name;
  drawIcon(span);
  return span;
}
function drawIcon(span) {
  span.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + paths[span.dataset.icon] + '</svg>';
}
document.querySelectorAll('[data-icon]').forEach(drawIcon);
function el(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value) node.textContent = value;
  return node;
}
function button(label, callback, className = 'secondary') {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', callback);
  return node;
}
function fillSelect(select, values) {
  values.forEach(value => select.add(new Option(value, value)));
}
const form = $('action-form');
const field = name => form.elements.namedItem(name);
fillSelect(field('category'), categories);
fillSelect(field('priority'), priorities);
fillSelect($('category'), categories);

let noticeTimer;
function notify(message) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  const notice = $('notice');
  if (notice.showPopover && !notice.matches(':popover-open')) notice.showPopover();
  noticeTimer = setTimeout(() => {
    notice.hidePopover?.();
    notice.textContent = '';
  }, 6200);
}

let items = [];
let queue = [];
let suggestions = [];
let qrResults = [];
let retakeTarget;
let filter = 'Open';
let month = new Date();
let selectedDay = '';
let editing;
let editorImage;
let busy = false;
let configured = false;
let statusChecked = false;
let initialStatus = false;
let demoLoaded = false;
let cloud;
let cloudState = 'local';
let uid;
let accountEmail = '';
let unsubscribeItems;
let authMode = 'login';
let accountRequest = false;
let cloudInboxLoaded = false;
let scanMessage = '';
let scanSeen = false;

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#f1f5f1' : '#101915';
  const control = $('theme');
  control.replaceChildren(icon(theme === 'light' ? 'moon' : 'sun'));
  control.setAttribute('aria-label', 'Switch to ' + (theme === 'light' ? 'dark' : 'light') + ' mode');
}
let theme = 'dark';
try { theme = localStorage.getItem('lifesnap-theme') || theme; } catch {}
setTheme(theme);
$('theme').onclick = () => {
  theme = theme === 'light' ? 'dark' : 'light';
  setTheme(theme);
  try { localStorage.setItem('lifesnap-theme', theme); } catch {}
};

const db = new Promise((resolve, reject) => {
  const request = indexedDB.open('lifesnap', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('actions', {keyPath: 'id'});
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function readActions() {
  const database = await db;
  return new Promise((resolve, reject) => {
    const request = database.transaction('actions').objectStore('actions').getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let changes = Promise.resolve();
const sync = typeof BroadcastChannel === 'function' ? new BroadcastChannel('lifesnap-actions') : null;
if (sync) sync.onmessage = () => refreshItems();
async function refreshItems() {
  if (uid) return;
  try {
    const guest = await readActions();
    if (uid) return;
    items = guest;
    render();
  } catch {
    notify('Browser storage is unavailable. Allow local storage to save actions.');
  }
}

function saveChanges(put = [], remove = []) {
  const owner = uid;
  const pending = changes.then(async () => {
    if (owner !== uid) throw new Error('Account changed.');
    if (owner) {
      if (!cloudInboxLoaded) throw new Error('Cloud inbox is loading.');
      if (!navigator.onLine) throw new Error('Cloud inbox is offline.');
      await cloud.save(owner, put, remove);
      return true;
    }
    const database = await db;
    await new Promise((resolve, reject) => {
      const tx = database.transaction('actions', 'readwrite');
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
      const store = tx.objectStore('actions');
      put.forEach(item => store.put(item));
      remove.forEach(id => store.delete(id));
    });
    await refreshItems();
    sync?.postMessage('updated');
    return true;
  }).catch(() => {
    notify(owner ? 'Could not sync changes. Check your connection and Firebase setup.'
      : 'Could not save changes. Check that browser storage is available.');
    return false;
  });
  changes = pending;
  return pending;
}

function renderAuth() {
  const signedIn = Boolean(uid);
  const usable = cloudState === 'ready';
  const register = authMode === 'signup';
  $('account').textContent = signedIn ? 'Account' : 'Log in';
  $('storage-label').textContent = signedIn ? 'Cloud inbox · Synced with Firebase' : 'Guest inbox · Saved on this device';
  $('auth-title').textContent = signedIn ? 'Your account' : register ? 'Create account' : 'Log in';
  $('auth-detail').textContent = signedIn ? accountEmail : usable ? 'Sign in to sync your inbox across devices.' :
    cloudState === 'loading' ? 'Connecting to Firebase…' : 'Firebase sign-in needs configuration. The guest inbox is available now.';
  for (const id of ['auth-tabs', 'auth-email-label', 'auth-password-label', 'auth-submit', 'auth-google']) $(id).hidden = signedIn || !usable;
  $('auth-import').hidden = $('auth-signout').hidden = !signedIn;
  for (const id of ['auth-submit', 'auth-import', 'auth-signout', 'auth-google']) $(id).disabled = accountRequest;
  $('auth-import').disabled = accountRequest || !cloudInboxLoaded;
  $('auth-login').setAttribute('aria-pressed', String(!register));
  $('auth-signup').setAttribute('aria-pressed', String(register));
  $('auth-password').autocomplete = register ? 'new-password' : 'current-password';
  $('auth-submit').textContent = register ? 'Create account' : 'Log in';
}
$('account').onclick = () => {
  $('auth-message').textContent = '';
  renderAuth();
  $('auth-dialog').showModal();
};
$('close-auth').onclick = () => $('auth-dialog').close();
$('auth-dialog').addEventListener('close', () => { $('auth-password').value = ''; });
for (const mode of ['login', 'signup']) {
  $('auth-' + mode).onclick = () => {
    authMode = mode;
    $('auth-message').textContent = '';
    renderAuth();
  };
}
$('auth-form').onsubmit = async event => {
  event.preventDefault();
  if (!cloud || accountRequest || uid) return;
  accountRequest = true;
  $('auth-message').textContent = '';
  renderAuth();
  try {
    await cloud.authenticate(authMode, $('auth-email').value.trim(), $('auth-password').value);
    $('auth-dialog').close();
  } catch (error) {
    $('auth-message').textContent = authError(error);
  } finally {
    accountRequest = false;
    renderAuth();
  }
};
$('auth-google').onclick = async () => {
  if (!cloud || accountRequest || uid) return;
  accountRequest = true;
  $('auth-message').textContent = '';
  renderAuth();
  try {
    await cloud.googleSignIn();
    $('auth-dialog').close();
  } catch (error) {
    $('auth-message').textContent = authError(error);
  } finally {
    accountRequest = false;
    renderAuth();
  }
};
$('auth-signout').onclick = async () => {
  accountRequest = true;
  renderAuth();
  try {
    await cloud.signOut();
    $('auth-dialog').close();
  } catch (error) {
    $('auth-message').textContent = authError(error);
  } finally {
    accountRequest = false;
    renderAuth();
  }
};
$('auth-import').onclick = async () => {
  const owner = uid;
  accountRequest = true;
  renderAuth();
  let failed = false;
  try {
    const existing = new Set(items.map(item => item.id));
    const guest = (await readActions()).filter(item => !existing.has(item.id));
    if (!guest.length) {
      $('auth-message').textContent = 'No new guest actions to copy.';
      return;
    }
    for (let offset = 0; offset < guest.length; offset += 12) {
      if (owner !== uid || !await saveChanges(guest.slice(offset, offset + 12))) {
        failed = true;
        break;
      }
    }
    $('auth-message').textContent = failed ? 'Could not finish copying. You can retry.' : 'Guest actions copied to your account.';
  } catch {
    $('auth-message').textContent = 'Could not read the guest inbox.';
  } finally {
    accountRequest = false;
    renderAuth();
  }
};

async function loadCloud(config) {
  if (!config || cloudState !== 'local') return;
  cloudState = 'loading';
  renderAuth();
  try {
    cloud = await connectFirebase(config);
    cloudState = 'ready';
    cloud.observe(user => {
      const nextUser = user?.uid;
      if (uid !== nextUser) {
        unsubscribeItems?.();
        uid = nextUser;
        cloudInboxLoaded = false;
        accountEmail = user?.email || '';
        $('editor').close();
        $('confirm-delete').close();
        items = [];
        filter = 'Open';
        render();
        if (uid) {
          unsubscribeItems = cloud.watch(uid, fresh => {
            if (uid !== nextUser) return;
            items = fresh;
            cloudInboxLoaded = true;
            renderAuth();
            render();
          }, () => notify('Could not load the cloud inbox. Check Firestore setup and rules.'));
        } else {
          refreshItems();
        }
      }
      renderAuth();
    }, error => notify(authError(error)));
  } catch {
    cloudState = 'local';
    notify('Could not connect to Firebase. Guest mode is available.');
  }
  renderAuth();
}

function action(values) {
  return {id: crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''),
    title: '', category: 'Task', priority: 'Normal', description: '', date: '', time: '', next: '', uncertainty: '',
    completed: false, created: Date.now(), ...values};
}
const dateFormat = new Intl.DateTimeFormat('en-NZ', {day: 'numeric', month: 'short'});
const fullDateFormat = new Intl.DateTimeFormat('en-NZ', {dateStyle: 'full'});
const monthFormat = new Intl.DateTimeFormat('en-NZ', {month: 'long', year: 'numeric'});
const ordered = list => [...list].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999')
  || a.time.localeCompare(b.time) || b.created - a.created);
const duplicate = item => items.some(saved => saved.title.toLowerCase() === item.title.toLowerCase() && saved.date === item.date);

function card(item, review = false) {
  const row = el('article', 'action' + (item.completed ? ' done' : ''));
  if (!review) {
    const toggle = button('', async () => {
      toggle.disabled = true;
      if (!await saveChanges([{...item, completed: !item.completed}])) toggle.disabled = false;
    }, 'toggle');
    toggle.setAttribute('aria-label', (item.completed ? 'Reopen ' : 'Complete ') + item.title);
    toggle.setAttribute('aria-pressed', String(item.completed));
    if (item.completed) toggle.append(icon('check'));
    row.append(toggle);
  }
  const copy = el('div', 'action-copy');
  copy.append(el('span', 'action-title', item.title));
  if (item.description) {
    const notes = el('div', 'action-notes');
    appendReadableText(notes, item.description);
    copy.append(notes);
  }
  if (review && item.next) {
    const next = el('p', 'action-next');
    next.append(el('strong', '', 'Next step'), ' ' + readableAIText(item.next).trim());
    copy.append(next);
  }
  const chips = el('div', 'chips');
  chips.append(el('span', 'chip', item.category));
  if (item.date) chips.append(el('span', 'chip' + (item.date < dateKey() && !item.completed && !review ? ' urgent' : ''),
    dateFormat.format(localDate(item.date)) + (item.time ? ' · ' + item.time : '') + (item.date < dateKey() && !item.completed && !review ? ' · Overdue' : '')));
  if (item.source) chips.append(el('span', 'chip source-chip', item.sourceName ? 'Image · ' + item.sourceName : 'Source image'));
  if (item.priority !== 'Normal') chips.append(el('span', 'chip' + (item.priority === 'High' ? ' urgent' : ''), item.priority + ' priority'));
  if (item.uncertainty) chips.append(el('span', 'chip urgent', 'Needs review'));
  if (review && duplicate(item)) chips.append(el('span', 'chip urgent', 'Possible duplicate'));
  if (review && item.uncertainty) copy.append(el('p', 'warning', item.uncertainty));
  copy.append(chips);
  const edit = button('Edit', () => openEditor(item, {review}));
  edit.setAttribute('aria-label', 'Edit ' + item.title);
  const controls = el('div', 'action-controls');
  const more = button('More info', () => openEditor(item, {review, lookup: true}));
  more.setAttribute('aria-label', 'More info about ' + item.title);
  controls.append(more, edit);
  if (review) controls.append(button('Dismiss', () => {
    suggestions = suggestions.filter(value => item !== value);
    renderReview();
  }, 'secondary'));
  row.append(copy, controls);
  return row;
}

function empty(title, message, sample = false) {
  const node = el('div', 'empty');
  const symbol = icon('check');
  symbol.className = 'empty-icon';
  node.append(symbol, el('strong', '', title), el('p', '', message));
  if (sample) node.append(button('Load sample actions', loadDemo, 'demo'));
  return node;
}

async function loadDemo(event) {
  event.currentTarget.disabled = true;
  const day = offset => { const date = new Date(); date.setDate(date.getDate() + offset); return dateKey(date); };
  const samples = [
    action({title: 'Pick up photo prints', category: 'Task', date: day(0), time: '15:30', description: 'Collect the order from the print shop.'}),
    action({title: 'Dentist appointment', category: 'Appointment', date: day(2), time: '10:00', next: 'Bring your insurance card.'}),
    action({title: 'Pay power bill', category: 'Bill', date: day(5), priority: 'High', description: 'Check the amount and payment reference on the invoice.'})
  ];
  demoLoaded = await saveChanges(samples);
  if (demoLoaded) {
    filter = 'Open';
    render();
    notify('Sample actions added.');
  } else render();
}

function renderInbox() {
  const open = items.filter(item => !item.completed).length;
  $('counts').textContent = items.length ? open + ' open · ' + (items.length - open) + ' completed' : 'Keep track of what needs doing.';
  const query = $('search').value.trim().toLowerCase();
  const category = $('category').value;
  const filtered = ordered(items.filter(item => (
    filter === 'All' || item.completed === (filter === 'Completed')) && (!category || item.category === category)
    && [item.title, item.description, item.next].some(value => value.toLowerCase().includes(query))));
  document.querySelectorAll('[data-filter]').forEach(tab => tab.setAttribute('aria-pressed', String(tab.dataset.filter === filter)));
  $('actions').replaceChildren(...(filtered.length ? filtered.map(item => card(item))
    : [items.length || query || category || filter === 'Completed'
      ? empty('No matching actions', 'Try a different filter or add an action.')
      : empty('A clear inbox', 'Upload a screenshot or add an action to get started.', !demoLoaded)]));
}

function moveMonth(offset) {
  month = new Date(month.getFullYear(), month.getMonth() + offset, 1);
  selectedDay = '';
  renderCalendar();
}
function renderCalendar() {
  const year = month.getFullYear();
  const number = month.getMonth();
  const start = new Date(year, number, 1);
  const dated = ordered(items.filter(item => item.date && !item.completed));
  const inMonth = dated.filter(item => item.date.slice(0, 7) === dateKey(start).slice(0, 7));
  $('month').textContent = monthFormat.format(start);
  $('export-all').disabled = !dated.length;
  const grid = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => el('div', 'weekday', day));
  for (let i = 0; i < (start.getDay() + 6) % 7; i++) grid.push(el('div'));
  for (let i = 1; i <= new Date(year, number + 1, 0).getDate(); i++) {
    const date = new Date(year, number, i);
    const key = dateKey(date);
    const count = inMonth.filter(item => item.date === key).length;
    const day = button(String(i), () => {
      selectedDay = selectedDay === key ? '' : key;
      renderCalendar();
      document.querySelector('[data-day="' + key + '"]')?.focus();
    }, 'day');
    day.dataset.day = key;
    day.setAttribute('aria-pressed', String(key === selectedDay));
    day.setAttribute('aria-label', fullDateFormat.format(date) + ', ' + count + ' actions');
    if (key === dateKey()) day.setAttribute('aria-current', 'date');
    if (count) day.append(el('small', '', String(count) + ' •'));
    grid.push(day);
  }
  $('calendar-grid').replaceChildren(...grid);
  const agenda = selectedDay ? inMonth.filter(item => item.date === selectedDay) : inMonth;
  $('agenda-title').textContent = selectedDay ? fullDateFormat.format(localDate(selectedDay)) : 'Month agenda';
  $('agenda').replaceChildren(...(agenda.length ? agenda.map(item => card(item)) : [empty('Nothing scheduled', 'Dated actions appear here.')]));
}

function render() {
  renderInbox();
  renderCalendar();
  renderReview();
}
function navigate() {
  const calendar = location.hash === '#calendar';
  $('inbox').hidden = calendar;
  $('calendar').hidden = !calendar;
  $('nav-inbox').toggleAttribute('aria-current', !calendar);
  $('nav-calendar').toggleAttribute('aria-current', calendar);
  window.scrollTo(0, 0);
}

function openEditor(item, {review = false, date = '', lookup = false} = {}) {
  editing = {item, review};
  const values = item || action({date});
  $('editor-title').textContent = item ? (review ? 'Review suggestion' : 'Edit action') : 'New action';
  for (const name of ['title', 'category', 'priority', 'description', 'date', 'time', 'next']) field(name).value = values[name];
  $('delete').hidden = !item || review;
  $('export-one').hidden = !item?.date || review;
  $('uncertainty').hidden = !values.uncertainty;
  $('uncertainty').textContent = values.uncertainty;
  $('source').hidden = !values.source;
  $('source').open = false;
  if (values.source) {
    editorImage = URL.createObjectURL(values.source);
    $('source').querySelector('img').src = editorImage;
  }
  $('web-lookup').open = lookup;
  $('web-question').value = lookup ? ('What is ' + item.title + '?').slice(0, 280) : '';
  $('web-result').replaceChildren();
  $('editor').showModal();
  if (lookup) $('web-question').focus();
  else field('title').focus();
}
$('editor').addEventListener('close', () => {
  lookupRequest?.abort();
  if (editorImage) URL.revokeObjectURL(editorImage);
  editorImage = undefined;
  $('source').querySelector('img').removeAttribute('src');
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  data.title = data.title.trim();
  if (!data.title) return notify('Enter a title.');
  if (data.date && !validDate(data.date)) return notify('Enter a valid date.');
  if (data.time && (!validTime(data.time) || !data.date)) return notify('Choose a date for the time.');
  const {item, review} = editing;
  const updated = {...(item || action({})), ...data, uncertainty: ''};
  if (review) {
    Object.assign(item, updated);
    renderReview();
    $('editor').close();
    return;
  }
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  if (await saveChanges([updated])) {
    $('editor').close();
    notify('Action saved.');
  }
  submit.disabled = false;
});
$('close-editor').onclick = () => $('editor').close();
$('delete').onclick = () => {
  $('confirm-delete').returnValue = 'cancel';
  $('confirm-delete').showModal();
};
$('confirm-delete').addEventListener('close', async () => {
  if ($('confirm-delete').returnValue === 'delete' && await saveChanges([], [editing.item.id])) {
    $('editor').close();
    notify('Action deleted.');
  }
});
function webLink(url, label, className) {
  const link = el('a', className, label);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function readableAIText(value) {
  return value.replace(/^(?:#{1,6} +)/gm, '').replaceAll('**', '').replaceAll('__', '').replaceAll('```', '');
}

function appendReadableText(parent, value) {
  const lines = readableAIText(value).replace(/\r\n?/g, '\n').split('\n');
  let list;
  let paragraph = [];
  function flush() {
    if (paragraph.length) parent.append(el('p', '', paragraph.join(' ')));
    paragraph = [];
  }
  for (const raw of lines) {
    const line = raw.trim();
    const bullet = line.match(/^([-*•]|(\d+)[.)])\s+(.+)$/);
    if (bullet) {
      flush();
      const kind = bullet[2] ? 'OL' : 'UL';
      if (!list || list.tagName !== kind) {
        list = el(kind.toLowerCase());
        if (bullet[2]) list.start = Number(bullet[2]);
        parent.append(list);
      }
      list.append(el('li', '', bullet[3]));
    } else {
      list = undefined;
      if (line) paragraph.push(line);
      else flush();
    }
  }
  flush();
}

function showExplanation(result) {
  const target = $('web-result');
  target.replaceChildren(el('strong', '', 'Gemini explanation'));
  target.append(el('p', 'answer-note', [result.fallback, 'This answer has no live web sources.'].filter(Boolean).join(' ')));
  appendReadableText(target, result.explanation.summary);
  if (result.explanation.points.length) {
    const list = el('ul');
    for (const point of result.explanation.points) list.append(el('li', '', readableAIText(point)));
    target.append(list);
  }
}

function showWebResult(result) {
  const target = $('web-result');
  const citations = new Map();
  const answer = document.createDocumentFragment();
  for (const block of result.blocks) {
    if (!block.annotations?.length) {
      appendReadableText(answer, block.text);
      continue;
    }
    const paragraph = el('p', 'cited-answer');
    let cursor = 0;
    const annotations = (block.annotations || []).filter(annotation => annotation.type === 'url_citation'
      && typeof annotation.url === 'string' && /^https?:\/\//i.test(annotation.url)
      && Number.isInteger(annotation.end_index) && annotation.end_index > 0 && annotation.end_index <= block.text.length)
      .sort((a, b) => a.end_index - b.end_index);
    for (const citation of annotations) {
      paragraph.append(readableAIText(block.text.slice(cursor, citation.end_index)));
      cursor = citation.end_index;
      if (!citations.has(citation.url)) citations.set(citation.url, {
        number: citations.size + 1, title: citation.title || citation.url
      });
      const source = citations.get(citation.url);
      const marker = webLink(citation.url, '[' + source.number + ']', 'citation');
      marker.setAttribute('aria-label', 'Source ' + source.number + ', ' + source.title);
      paragraph.append(marker);
    }
    paragraph.append(readableAIText(block.text.slice(cursor)));
    answer.append(paragraph);
  }
  if (!citations.size) {
    target.textContent = 'Google returned no cited web answer. Try a more specific question.';
    return;
  }
  target.replaceChildren(answer, el('strong', '', 'Web sources'));
  const sources = el('ul');
  for (const [url, source] of citations) {
    const item = el('li');
    item.append(webLink(url, '[' + source.number + '] ' + source.title));
    sources.append(item);
  }
  target.append(sources);

  const related = new Map();
  for (const html of result.suggestions) {
    const template = el('template');
    template.innerHTML = html;
    for (const link of template.content.querySelectorAll('a[href]')) {
      try {
        const url = new URL(link.getAttribute('href'), 'https://www.google.com');
        if (url.protocol === 'https:' && /(^|\.)google\.com$/i.test(url.hostname) && link.textContent.trim()) {
          related.set(url.href, link.textContent.trim());
        }
      } catch {
        continue;
      }
    }
  }
  if (related.size) {
    target.append(el('strong', '', 'Google Search suggestions'));
    const list = el('ul');
    for (const [url, label] of related) {
      const item = el('li');
      item.append(webLink(url, label));
      list.append(item);
    }
    target.append(list);
  }
}

let lookupRequest;
async function askQuestion(geminiOnly) {
  if (lookupRequest) return;
  const question = $('web-question').value.trim();
  if (!question) {
    $('web-result').textContent = 'Enter a question.';
    $('web-question').focus();
    return;
  }
  const request = new AbortController();
  lookupRequest = request;
  $('web-search').disabled = $('ask-gemini').disabled = true;
  $('web-result').textContent = geminiOnly ? 'Asking Gemini…' : 'Searching the web…';
  try {
    const response = await fetch(geminiOnly ? '/api/explain' : '/api/lookup', {method: 'POST', body: question, signal: request.signal});
    const result = await response.json();
    if (request.signal.aborted) return;
    if (!response.ok) throw new Error(result.error);
    if (result.explanation) showExplanation(result);
    else showWebResult(result);
  } catch (error) {
    if (!request.signal.aborted) $('web-result').textContent = error.message || 'Web lookup failed.';
  } finally {
    if (lookupRequest === request) {
      lookupRequest = undefined;
      $('web-search').disabled = $('ask-gemini').disabled = false;
    }
  }
}
$('ask-gemini').onclick = () => askQuestion(true);
$('web-search').onclick = () => askQuestion(false);

function exportCalendar(actions, filename) {
  const url = URL.createObjectURL(new Blob([calendarFile(actions)], {type: 'text/calendar;charset=utf-8'}));
  const link = el('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
$('export-all').onclick = () => exportCalendar(items.filter(item => !item.completed && item.date), 'lifesnap-calendar.ics');
$('export-one').onclick = () => exportCalendar([editing.item], 'lifesnap-action.ics');
$('add').onclick = () => openEditor();
$('add-date').onclick = () => openEditor(null, {date: selectedDay});
$('prev').onclick = () => moveMonth(-1);
$('next').onclick = () => moveMonth(1);
$('today').onclick = () => { month = new Date(); selectedDay = dateKey(); renderCalendar(); };
$('search').oninput = renderInbox;
$('category').onchange = renderInbox;
document.querySelectorAll('[data-filter]').forEach(tab => {
  tab.onclick = () => { filter = tab.dataset.filter; renderInbox(); };
});

const accepted = ['image/png', 'image/jpeg', 'image/webp'];
const limit = 8 * 1024 * 1024;

async function prepareImage(file, camera) {
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const tag = String.fromCharCode(...bytes);
  const nativeType = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
    : tag.startsWith('\x89PNG\r\n\x1a\n') ? 'image/png'
    : tag.startsWith('RIFF') && tag.slice(8, 12) === 'WEBP' ? 'image/webp' : '';
  const heic = /^image\/(heic|heif)(-sequence)?$/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)
    || (tag.slice(4, 8) === 'ftyp' && /heic|heix|hevc|hevx|mif1|msf1/.test(tag.slice(8)));
  if (accepted.includes(nativeType) && file.size <= limit && (!camera || file.size < 2 * 1024 * 1024)) {
    return file.type === nativeType ? file : file.slice(0, file.size, nativeType);
  }
  if (!nativeType && !heic) throw new Error('Choose PNG, JPEG, WebP or HEIC.');
  const image = new Image();
  const url = URL.createObjectURL(file);
  try {
    image.src = url;
    await image.decode();
    const scale = Math.min(1, 2400 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = el('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = 'white';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .88));
    if (blob && blob.size <= limit) return blob;
    throw new Error('Photo is too large.');
  } catch {
    if (!heic) throw new Error('Could not prepare this image. Try a smaller photo or JPEG.');
    if (file.size > 16 * 1024 * 1024) throw new Error('This HEIC photo is over 16 MB. Try a smaller photo.');
    const response = await fetch('/api/photo', {method: 'POST', body: file, signal: AbortSignal.timeout(30_000)});
    if (!response.ok) throw new Error((await response.json()).error);
    return response.blob();
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function addFiles(files, {camera = false, replace = null} = {}) {
  if (busy || !files.length) return;
  const previous = replace && queue.includes(replace) ? [replace] : [];
  busy = true;
  scanSeen = true;
  $('scan-progress-track').hidden = true;
  $('photo-error').hidden = true;
  scanMessage = camera ? 'Preparing your photo…' : 'Preparing your images…';
  $('scan-progress').textContent = '';
  renderQueue();
  openScan();
  const errors = [];
  for (const file of files.slice(0, 12 - queue.length + previous.length)) {
    try {
      const blob = await prepareImage(file, camera);
      if (previous.length) {
        queue = queue.filter(entry => !previous.includes(entry));
        previous.forEach(entry => URL.revokeObjectURL(entry.url));
      }
      queue.push({name: camera ? 'Camera photo' : file.name, blob, url: URL.createObjectURL(blob), status: '', camera});
    } catch (error) {
      errors.push(camera ? (error.message || 'Try taking the photo again.') : file.name + ' — ' + error.message);
    }
  }
  busy = false;
  scanMessage = errors.length && !queue.length ? 'Could not add the image.' :
    camera && !errors.length ? 'Photo ready. Check the preview before scanning.' : 'Check your images, then choose Analyse images.';
  $('photo-error').hidden = !errors.length;
  $('photo-error').textContent = errors.join(' ');
  if (!errors.length && queue.length === 12) notify('The queue holds up to 12 images.');
  renderQueue();
}

function openScan() {
  const dialog = $('scan-dialog');
  if (!dialog.open) dialog.showModal();
}
$('scan-summary').onclick = openScan;
$('close-scan').onclick = () => $('scan-dialog').close();
$('scan-dialog').addEventListener('close', () => $('scan-summary').focus());

function renderScanSummary() {
  $('scan-summary').hidden = !scanSeen;
  let status;
  if (busy) status = scanMessage;
  else if (suggestions.length || qrResults.length) status = [
    suggestions.length ? suggestions.length + ' ready to review' : '',
    qrResults.length ? qrResults.length + (qrResults.length === 1 ? ' QR code' : ' QR codes') : '',
    queue.length ? queue.length + ' images queued' : ''
  ].filter(Boolean).join(' · ');
  else if (queue.length) status = queue.length + (queue.length === 1 ? ' image queued' : ' images queued');
  else status = scanMessage || 'No pending images';
  $('summary-status').textContent = status;
  $('scan-state').textContent = busy || !suggestions.length ? scanMessage : status;
}

function renderQueue() {
  $('queue-panel').hidden = !queue.length;
  renderScanSummary();
  $('analyse').disabled = !navigator.onLine || busy || !queue.length;
  $('qr-only').disabled = busy || !configured;
  if (!configured) $('qr-only').checked = true;
  else if (!initialStatus) $('qr-only').checked = false;
  $('analyse').textContent = busy ? 'Processing…' : $('qr-only').checked ? 'Scan QR codes' : 'Analyse images';
  $('upload').disabled = $('camera').disabled = busy;
  $('queue').replaceChildren(...queue.map(entry => {
    const node = el('div', 'thumb');
    const img = el('img');
    img.src = entry.url;
    img.alt = 'Preview of ' + entry.name;
    node.append(img, el('p', '', entry.name));
    if (entry.status) node.append(el('p', '', entry.status));
    const remove = button('Remove', () => {
      queue = queue.filter(value => value !== entry);
      URL.revokeObjectURL(entry.url);
      renderQueue();
    });
    remove.disabled = busy;
    remove.setAttribute('aria-label', 'Remove ' + entry.name);
    const controls = el('div', 'buttons');
    if (entry.camera) {
      const retake = button('Retake', () => {
        retakeTarget = entry;
        $('retake').click();
      });
      retake.disabled = busy;
      controls.append(retake);
    }
    controls.append(remove);
    node.append(controls);
    return node;
  }));
}
function renderReview() {
  $('review-panel').hidden = !suggestions.length;
  renderScanSummary();
  $('save-review').disabled = !suggestions.some(item => item.selected);
  $('review').replaceChildren(...suggestions.map(item => {
    const row = el('div', 'review-item');
    const check = el('input');
    check.type = 'checkbox';
    check.checked = item.selected;
    check.setAttribute('aria-label', 'Save ' + item.title);
    check.onchange = () => {
      item.selected = check.checked;
      $('save-review').disabled = !suggestions.some(value => value.selected);
    };
    row.append(check, card(item, true));
    return row;
  }));
}

$('save-review').onclick = async () => {
  const selected = suggestions.filter(item => item.selected);
  $('save-review').disabled = true;
  if (await saveChanges(selected.map(({selected: checked, ...item}) => item))) {
    suggestions = suggestions.filter(item => !selected.includes(item));
    if (!busy) scanMessage = 'Saved to your inbox.';
    notify(selected.length + (selected.length === 1 ? ' action added.' : ' actions added.'));
  }
  renderReview();
};

function renderQR() {
  $('qr-panel').hidden = !qrResults.length;
  $('qr-results').replaceChildren(...qrResults.map(code => {
    const row = el('article', 'qr-result');
    row.append(el('strong', '', code.type), el('p', '', code.source));
    if (code.host) row.append(el('p', '', 'Domain · ' + code.host));
    if (code.scheme) row.append(el('p', '', 'Protocol · ' + code.scheme));
    row.append(el('pre', '', code.payload || '(empty payload)'));
    return row;
  }));
  renderScanSummary();
}
$('qr-only').onchange = renderQueue;

async function readScanResult(response, onProgress) {
  if (!response.headers.get('Content-Type')?.includes('text/event-stream')) {
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) throw new Error('The scan connection closed before results were ready. Try again.');
      pending += value;
      let boundary;
      while ((boundary = pending.indexOf('\n\n')) !== -1) {
        const row = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        if (!row.startsWith('data: ')) continue;
        const event = JSON.parse(row.slice(6));
        if (event.type === 'progress') onProgress(event);
        if (event.type === 'result') {
          if (event.result.error) throw new Error(event.result.error);
          return event.result;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

$('analyse').onclick = async () => {
  busy = true;
  const qrOnly = $('qr-only').checked || !configured;
  scanMessage = qrOnly ? 'Reading QR codes…' : 'Checking QR codes and extracting actions…';
  qrResults = [];
  renderQR();
  openScan();
  const meter = $('scan-meter');
  const compactMeter = $('summary-meter');
  for (const bar of [meter, compactMeter]) {
    bar.max = 100;
    bar.value = 0;
  }
  $('scan-progress-track').hidden = false;
  compactMeter.hidden = false;
  $('scan-percent').textContent = '0%';
  renderQueue();
  let count = 0;
  let failed = 0;
  const scanWarnings = [];
  const pending = [...queue];
  const total = pending.length;
  let finished = 0;
  const progressByImage = new Map(pending.map(image => [image, 0]));
  function updateProgress(entry, percent) {
    progressByImage.set(entry, percent);
    const progress = Math.floor([...progressByImage.values()].reduce((sum, value) => sum + value, 0) / total);
    meter.value = compactMeter.value = progress;
    $('scan-percent').textContent = progress + '%';
  }
  async function scan() {
    while (pending.length) {
      const entry = pending.shift();
      entry.status = 'Uploading image…';
      renderQueue();
      try {
        const response = await fetch('/api/extract', {
          method: 'POST', body: entry.blob,
          headers: {'Accept': 'text/event-stream', ...(qrOnly ? {'x-lifesnap-qr-only': '1'} : {})}
        });
        const result = await readScanResult(response, ({progress, stage}) => {
          entry.status = stage;
          updateProgress(entry, progress);
          $('scan-progress').textContent = stage;
          renderQueue();
        });
        for (const warning of [result.qrWarning, result.aiWarning].filter(Boolean)) scanWarnings.push(entry.name + ' · ' + warning);
        for (const code of result.codes || []) qrResults.push({...code, source: entry.name});
        renderQR();
        for (const values of result.items) {
          const item = action({...values, source: entry.blob, sourceName: entry.name.slice(0, 512)});
          item.selected = !duplicate(item) && !suggestions.some(value => value.title.toLowerCase() === item.title.toLowerCase() && value.date === item.date);
          suggestions.push(item);
          count++;
        }
        URL.revokeObjectURL(entry.url);
        queue = queue.filter(value => value !== entry);
        renderReview();
      } catch (error) {
        entry.status = error.message || 'Analysis failed. Try again.';
        failed++;
      } finally {
        finished++;
        updateProgress(entry, 100);
        $('scan-progress').textContent = 'Processed ' + finished + ' of ' + total + ' images.';
        renderQueue();
      }
    }
  }
  $('scan-progress').textContent = 'Processing ' + total + ' ' + (total === 1 ? 'image.' : 'images.');
  await Promise.all(Array.from({length: Math.min(3, total)}, () => scan()));
  busy = false;
  compactMeter.hidden = true;
  scanMessage = count || qrResults.length ? 'Scan complete. Review the results.' :
    failed ? 'Some images could not be scanned. You can retry.' :
    qrOnly ? 'Scan complete. No QR codes found.' : 'Scan complete. No actions or QR codes found.';
  if (scanWarnings.length) scanMessage += ' ' + scanWarnings.join(' ');
  renderQueue();
  notify(qrResults.length && !count ? qrResults.length + ' QR result' + (qrResults.length === 1 ? ' ready.' : 's ready.') : count ? count + (count === 1 ? ' suggestion ready.' : ' suggestions ready.') + (failed ? ' Some images need a retry.' : '')
    : failed ? 'Analysis failed. Check the messages on your images.' : 'No actions found in these images.');
};

$('upload').onclick = () => $('files').click();
$('camera').onclick = () => $('photo').click();
for (const id of ['files', 'photo', 'retake']) {
  $(id).onchange = event => {
    const files = Array.from(event.target.files);
    event.target.value = '';
    const replace = id === 'retake' ? retakeTarget : null;
    if (id === 'retake') retakeTarget = undefined;
    addFiles(files, {camera: id !== 'files', replace});
  };
}
const hero = document.querySelector('.hero');
hero.ondragover = event => {
  if (!Array.from(event.dataTransfer.types).includes('Files')) return;
  event.preventDefault();
  hero.classList.add('dragging');
};
hero.ondragleave = event => {
  if (!hero.contains(event.relatedTarget)) hero.classList.remove('dragging');
};
hero.ondrop = event => {
  event.preventDefault();
  hero.classList.remove('dragging');
  addFiles(Array.from(event.dataTransfer.files));
};
async function syncConnection() {
  if (navigator.onLine) {
    try {
      const result = await fetch('/api/status', {signal: AbortSignal.timeout(4500)}).then(response => response.json());
      configured = result.configured;
      statusChecked = true;
      void loadCloud(result.firebase);
    } catch {
      statusChecked = false;
    }
  }
  $('ai-status').textContent = !navigator.onLine ? 'Offline · Inbox available' : !statusChecked ? 'Gemini status unavailable'
    : configured ? 'Gemini ready' : 'Gemini key required for analysis';
  renderQueue();
  if (statusChecked) initialStatus = true;
}
addEventListener('online', syncConnection);
addEventListener('offline', syncConnection);
addEventListener('hashchange', navigate);
navigate();
renderAuth();
render();
refreshItems();
syncConnection();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
