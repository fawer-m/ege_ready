'use strict';

/*
  Подготовка к ЕГЭ.
  Конспекты и файлы хранятся в IndexedDB этого браузера. Сервер не нужен.
*/

const SUBJECTS = [
  { id: 'math', name: 'Математика', color: '#2B50C8' },
  { id: 'russian', name: 'Русский язык', color: '#C4313B' },
  { id: 'cs', name: 'Информатика', color: '#17806A' },
  { id: 'physics', name: 'Физика', color: '#7446BE' },
];

// Эти типы открываются в новой вкладке, остальные скачиваются.
// HTML и SVG намеренно не входят в список: они могут запускать скрипты.
const VIEWABLE_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/* ---------- Мелкие помощники ---------- */

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value == null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const kid of kids.flat()) if (kid != null) node.append(kid);
  return node;
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const dateShort = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const dateLong = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
function formatDate(ts) {
  const d = new Date(ts);
  return (d.getFullYear() === new Date().getFullYear() ? dateShort : dateLong).format(d);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1048576).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`;
}

function snippet(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat ? flat.slice(0, 80) : 'Пусто';
}

function extension(name) {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(name);
  return match ? match[1].toLowerCase() : 'файл';
}

let toastTimer = null;
function notify(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 5000);
}

function triggerDownload(url, name) {
  const link = el('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/* ---------- База данных (IndexedDB) ---------- */

const dbReady = new Promise((resolve, reject) => {
  const request = indexedDB.open('ege-prep', 1);
  request.onupgradeneeded = () => {
    const database = request.result;
    for (const name of ['notes', 'files']) {
      const store = database.createObjectStore(name, { keyPath: 'id' });
      store.createIndex('subject', 'subject');
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function run(storeName, mode, work) {
  const database = await dbReady;
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, mode);
    const request = work(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const db = {
  list: (store, subject) => run(store, 'readonly', (s) => s.index('subject').getAll(subject)),
  all: (store) => run(store, 'readonly', (s) => s.getAll()),
  count: (store, subject) => run(store, 'readonly', (s) => s.index('subject').count(subject)),
  put: (store, item) => run(store, 'readwrite', (s) => s.put(item)),
  remove: (store, id) => run(store, 'readwrite', (s) => s.delete(id)),
};

/* ---------- Состояние ---------- */

function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem('ege-prefs')) || {};
  } catch {
    return {};
  }
}

const prefs = readPrefs();
const state = {
  subject: SUBJECTS.some((s) => s.id === prefs.subject) ? prefs.subject : SUBJECTS[0].id,
  view: prefs.view === 'files' ? 'files' : 'notes',
  notes: [],
  files: [],
  activeNoteId: null,
};
const counts = {};
const navRefs = {};
let loadToken = 0;

function writePrefs() {
  try {
    localStorage.setItem('ege-prefs', JSON.stringify({ subject: state.subject, view: state.view }));
  } catch {
    /* без localStorage сайт работает, просто не помнит последний раздел */
  }
}

const currentSubject = () => SUBJECTS.find((s) => s.id === state.subject);
const activeNote = () => state.notes.find((n) => n.id === state.activeNoteId) || null;
const sortNotes = () => state.notes.sort((a, b) => b.updated - a.updated);
const sortFiles = () => state.files.sort((a, b) => b.added - a.added);

/* ---------- Предметы ---------- */

function buildSubjects() {
  const nav = $('subjects');
  for (const subject of SUBJECTS) {
    const badge = el('span', { class: 'badge', hidden: true });
    const btn = el(
      'button',
      {
        type: 'button',
        class: 'subject-btn',
        style: `--c: ${subject.color}`,
        onclick: () => selectSubject(subject.id),
      },
      el('span', { text: subject.name }),
      badge,
    );
    navRefs[subject.id] = { btn, badge };
    nav.append(btn);
  }
}

function updateSubjectNav() {
  for (const subject of SUBJECTS) {
    const { btn, badge } = navRefs[subject.id];
    if (subject.id === state.subject) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
    const c = counts[subject.id];
    const total = c ? c.notes + c.files : 0;
    badge.textContent = total ? String(total) : '';
    badge.hidden = !total;
  }
}

async function refreshCounts() {
  try {
    await Promise.all(
      SUBJECTS.map(async (subject) => {
        const [notes, files] = await Promise.all([
          db.count('notes', subject.id),
          db.count('files', subject.id),
        ]);
        counts[subject.id] = { notes, files };
      }),
    );
    updateSubjectNav();
  } catch (error) {
    console.error(error);
  }
}

async function selectSubject(id) {
  if (id === state.subject) return;
  await flushSave();
  state.subject = id;
  state.activeNoteId = null;
  writePrefs();
  updateSubjectNav();
  await loadSubject();
}

async function loadSubject() {
  const token = ++loadToken;
  const subject = currentSubject();
  document.documentElement.style.setProperty('--accent', subject.color);
  $('subject-title').textContent = subject.name;
  document.title = `${subject.name}. Подготовка к ЕГЭ`;
  try {
    const [notes, files] = await Promise.all([
      db.list('notes', subject.id),
      db.list('files', subject.id),
    ]);
    if (token !== loadToken) return;
    state.notes = notes;
    state.files = files;
  } catch (error) {
    console.error(error);
    notify('Не удалось прочитать сохранённые данные.');
    return;
  }
  sortNotes();
  sortFiles();
  if (!state.notes.some((n) => n.id === state.activeNoteId)) {
    state.activeNoteId = state.notes.length ? state.notes[0].id : null;
  }
  renderNoteList();
  renderEditor();
  renderFiles();
  renderCounts();
}

function renderCounts() {
  $('count-notes').textContent = state.notes.length || '';
  $('count-files').textContent = state.files.length || '';
}

/* ---------- Разделы «Конспекты» и «Файлы» ---------- */

function renderView() {
  const isNotes = state.view === 'notes';
  $('panel-notes').hidden = !isNotes;
  $('panel-files').hidden = isNotes;
  $('tab-notes').setAttribute('aria-selected', String(isNotes));
  $('tab-files').setAttribute('aria-selected', String(!isNotes));
  $('tab-notes').tabIndex = isNotes ? 0 : -1;
  $('tab-files').tabIndex = isNotes ? -1 : 0;
}

function setView(view) {
  flushSave();
  state.view = view;
  writePrefs();
  renderView();
}

function onTabKey(event) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const next = state.view === 'notes' ? 'files' : 'notes';
  setView(next);
  $(`tab-${next}`).focus();
}

/* ---------- Конспекты ---------- */

function renderNoteList() {
  const list = $('note-list');
  const hadFocus = list.contains(document.activeElement);
  list.replaceChildren(
    ...state.notes.map((note) =>
      el(
        'li',
        {},
        el(
          'button',
          {
            type: 'button',
            class: 'note-item',
            'aria-current': note.id === state.activeNoteId ? 'true' : false,
            onclick: () => openNote(note.id),
          },
          el('span', { class: 'note-item-title', text: note.title.trim() || 'Без названия' }),
          el('span', { class: 'note-item-snippet', text: snippet(note.body) }),
          el('span', { class: 'note-item-date', text: formatDate(note.updated) }),
        ),
      ),
    ),
  );
  if (hadFocus) {
    const current = list.querySelector('[aria-current="true"]');
    if (current) current.focus();
  }
}

function renderEditor() {
  const note = activeNote();
  $('editor').hidden = !note;
  $('notes-empty').hidden = !!note;
  if (note) {
    $('note-title').value = note.title;
    $('note-body').value = note.body;
    setStatus('');
  }
}

function setStatus(text) {
  $('save-status').textContent = text;
}

async function openNote(id) {
  if (id === state.activeNoteId) return;
  await flushSave();
  state.activeNoteId = id;
  renderNoteList();
  renderEditor();
}

async function newNote() {
  await flushSave();
  const open = activeNote();
  if (open && !open.title.trim() && !open.body.trim()) {
    $('note-title').focus();
    return;
  }
  const now = Date.now();
  const note = { id: uid(), subject: state.subject, title: '', body: '', created: now, updated: now };
  try {
    await db.put('notes', note);
  } catch (error) {
    console.error(error);
    notify('Не удалось создать конспект. Возможно, на устройстве не хватает места.');
    return;
  }
  state.notes.unshift(note);
  state.activeNoteId = note.id;
  renderNoteList();
  renderEditor();
  renderCounts();
  refreshCounts();
  $('note-title').focus();
}

async function deleteNote() {
  const note = activeNote();
  if (!note) return;
  const name = note.title.trim() || 'Без названия';
  if (!confirm(`Удалить конспект «${name}»? Это нельзя отменить.`)) return;
  if (pendingNote && pendingNote.id === note.id) {
    pendingNote = null;
    clearTimeout(saveTimer);
  }
  try {
    await db.remove('notes', note.id);
  } catch (error) {
    console.error(error);
    notify('Не удалось удалить конспект.');
    return;
  }
  state.notes = state.notes.filter((n) => n.id !== note.id);
  state.activeNoteId = state.notes.length ? state.notes[0].id : null;
  renderNoteList();
  renderEditor();
  renderCounts();
  refreshCounts();
  notify('Конспект удалён');
}

/* Автосохранение: через полсекунды после последней правки, при смене
   конспекта и при закрытии вкладки. */

let saveTimer = null;
let pendingNote = null;
let lastSave = Promise.resolve();

function onNoteInput() {
  const note = activeNote();
  if (!note) return;
  note.title = $('note-title').value;
  note.body = $('note-body').value;
  pendingNote = note;
  setStatus('Сохраняется…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 500);
}

function flushSave() {
  clearTimeout(saveTimer);
  const note = pendingNote;
  if (!note) return lastSave;
  pendingNote = null;
  note.updated = Date.now();
  lastSave = db
    .put('notes', { ...note })
    .then(() => {
      if (!pendingNote) setStatus('Сохранено');
      sortNotes();
      renderNoteList();
    })
    .catch((error) => {
      console.error(error);
      setStatus('Не сохранено');
      notify('Не удалось сохранить конспект. Скопируйте текст, чтобы не потерять его.');
    });
  return lastSave;
}

/* ---------- Файлы ---------- */

const canView = (file) => VIEWABLE_TYPES.has(file.type);

function renderFiles() {
  $('files-empty').hidden = state.files.length > 0;
  $('file-list').replaceChildren(
    ...state.files.map((file) => {
      const actions = [
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn-quiet',
            'aria-label': `${canView(file) ? 'Открыть' : 'Скачать'} ${file.name}`,
            onclick: () => (canView(file) ? openFile(file) : downloadFile(file)),
          },
          canView(file) ? 'Открыть' : 'Скачать',
        ),
      ];
      if (canView(file)) {
        actions.push(
          el(
            'button',
            {
              type: 'button',
              class: 'btn btn-quiet',
              'aria-label': `Скачать ${file.name}`,
              onclick: () => downloadFile(file),
            },
            'Скачать',
          ),
        );
      }
      actions.push(
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn-quiet btn-danger',
            'aria-label': `Удалить ${file.name}`,
            onclick: () => deleteFile(file),
          },
          'Удалить',
        ),
      );
      return el(
        'li',
        { class: 'file-row' },
        el('span', { class: 'file-badge', text: extension(file.name) }),
        el(
          'div',
          { class: 'file-info' },
          el('span', { class: 'file-name', text: file.name }),
          el('span', {
            class: 'file-meta',
            text: `${formatSize(file.size)}, добавлен ${formatDate(file.added)}`,
          }),
        ),
        el('div', { class: 'file-actions' }, actions),
      );
    }),
  );
}

async function addFiles(files) {
  if (!files.length) return;
  const subject = state.subject;
  let added = 0;
  for (const file of files) {
    const item = {
      id: uid(),
      subject,
      name: file.name,
      type: file.type || '',
      size: file.size,
      added: Date.now(),
      blob: file,
    };
    try {
      await db.put('files', item);
      added += 1;
      if (state.subject === subject) state.files.push(item);
    } catch (error) {
      console.error(error);
      notify(`Не удалось сохранить «${file.name}». Возможно, на устройстве не хватает места.`);
    }
  }
  sortFiles();
  renderFiles();
  renderCounts();
  refreshCounts();
  updateStorage();
  if (added) notify(added === 1 ? 'Файл добавлен' : `Добавлено файлов: ${added}`);
}

function openFile(file) {
  const url = URL.createObjectURL(file.blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
}

function downloadFile(file) {
  const url = URL.createObjectURL(file.blob);
  triggerDownload(url, file.name);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function deleteFile(file) {
  if (!confirm(`Удалить файл «${file.name}»? Это нельзя отменить.`)) return;
  try {
    await db.remove('files', file.id);
  } catch (error) {
    console.error(error);
    notify('Не удалось удалить файл.');
    return;
  }
  state.files = state.files.filter((f) => f.id !== file.id);
  renderFiles();
  renderCounts();
  refreshCounts();
  updateStorage();
  notify('Файл удалён');
}

/* ---------- Копия данных ---------- */

async function exportBackup() {
  try {
    await flushSave();
    const [notes, files] = await Promise.all([db.all('notes'), db.all('files')]);
    const packedFiles = [];
    for (const file of files) {
      packedFiles.push({
        id: file.id,
        subject: file.subject,
        name: file.name,
        type: file.type,
        size: file.size,
        added: file.added,
        data: await blobToDataURL(file.blob),
      });
    }
    const payload = {
      app: 'ege-prep',
      version: 1,
      exported: new Date().toISOString(),
      notes,
      files: packedFiles,
    };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, `ege-backup-${new Date().toISOString().slice(0, 10)}.json`);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    notify('Копия сохранена в загрузки');
  } catch (error) {
    console.error(error);
    notify('Не удалось сохранить копию. Возможно, файлов слишком много для одного архива.');
  }
}

async function importBackup(file) {
  try {
    await flushSave();
    const data = JSON.parse(await file.text());
    if (!data || data.app !== 'ege-prep' || !Array.isArray(data.notes) || !Array.isArray(data.files)) {
      throw new Error('Неверный формат копии');
    }
    const known = new Set(SUBJECTS.map((s) => s.id));
    let notes = 0;
    let files = 0;

    for (const note of data.notes) {
      if (!note || typeof note.id !== 'string' || !known.has(note.subject)) continue;
      await db.put('notes', {
        id: note.id,
        subject: note.subject,
        title: String(note.title ?? ''),
        body: String(note.body ?? ''),
        created: Number(note.created) || Date.now(),
        updated: Number(note.updated) || Date.now(),
      });
      notes += 1;
    }

    for (const item of data.files) {
      if (!item || typeof item.id !== 'string' || !known.has(item.subject)) continue;
      if (typeof item.data !== 'string' || !item.data.startsWith('data:')) continue;
      const raw = await (await fetch(item.data)).blob();
      const type = String(item.type || '');
      const blob = type ? new Blob([raw], { type }) : raw;
      await db.put('files', {
        id: item.id,
        subject: item.subject,
        name: String(item.name || 'файл'),
        type,
        size: blob.size,
        added: Number(item.added) || Date.now(),
        blob,
      });
      files += 1;
    }

    await loadSubject();
    refreshCounts();
    updateStorage();
    notify(`Копия добавлена к вашим данным. Конспектов: ${notes}, файлов: ${files}`);
  } catch (error) {
    console.error(error);
    notify('Не удалось прочитать копию. Выберите файл, который сохранил этот сайт.');
  } finally {
    $('import').value = '';
  }
}

/* ---------- Хранилище ---------- */

async function updateStorage() {
  const out = $('storage');
  if (!navigator.storage || !navigator.storage.estimate) {
    out.hidden = true;
    return;
  }
  try {
    const { usage } = await navigator.storage.estimate();
    out.textContent = `Занято в браузере: ${formatSize(usage || 0)}`;
    out.hidden = false;
  } catch {
    out.hidden = true;
  }
}

/* ---------- События и запуск ---------- */

function bindEvents() {
  $('tab-notes').addEventListener('click', () => setView('notes'));
  $('tab-files').addEventListener('click', () => setView('files'));
  $('tab-notes').addEventListener('keydown', onTabKey);
  $('tab-files').addEventListener('keydown', onTabKey);

  $('new-note').addEventListener('click', newNote);
  $('new-note-empty').addEventListener('click', newNote);
  $('delete-note').addEventListener('click', deleteNote);
  $('note-title').addEventListener('input', onNoteInput);
  $('note-body').addEventListener('input', onNoteInput);
  $('note-title').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      $('note-body').focus();
    }
  });

  $('file-input').addEventListener('change', (event) => {
    const picked = [...event.target.files];
    event.target.value = '';
    addFiles(picked);
  });

  const drop = $('drop');
  drop.addEventListener('dragover', (event) => {
    event.preventDefault();
    drop.classList.add('is-over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('is-over');
    addFiles([...event.dataTransfer.files]);
  });
  // Файл, брошенный мимо зоны, не должен открываться вместо сайта.
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());

  $('export').addEventListener('click', exportBackup);
  $('import').addEventListener('change', (event) => {
    const [file] = event.target.files;
    if (file) importBackup(file);
  });

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      flushSave();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
  });
  window.addEventListener('pagehide', flushSave);
}

async function init() {
  buildSubjects();
  updateSubjectNav();
  bindEvents();
  renderView();
  try {
    await dbReady;
  } catch (error) {
    console.error(error);
    $('workspace').hidden = true;
    $('fatal').hidden = false;
    return;
  }
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }
  await loadSubject();
  refreshCounts();
  updateStorage();
}

init();
