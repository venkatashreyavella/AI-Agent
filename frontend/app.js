const STORAGE_KEY = 'northstar.conversations.v1';
const $ = (selector) => document.querySelector(selector);
const listEl = $('#conversation-list');
const messagesEl = $('#messages');
const welcomeEl = $('#welcome');
const promptEl = $('#prompt');
const sendButton = $('#send-button');
let conversations = loadConversations();
let activeId = null;
let busy = false;
window.accessRequired = false;

function loadConversations() {
  try { const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); return Array.isArray(value) ? value : []; }
  catch { return []; }
}
function persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations)); }
function activeConversation() { return conversations.find((item) => item.id === activeId); }
function escapeHtml(value) { return value.replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
function markdown(source) {
  let html = escapeHtml(source);
  const blocks = [];
  html = html.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => { blocks.push(`<pre><code>${code.trimEnd()}</code></pre>`); return `@@BLOCK${blocks.length - 1}@@`; });
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>').replace(/^## (.+)$/gm, '<h2>$1</h2>').replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>').replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/(?:<li>.*?<\/li>\n?)+/gs, (chunk) => `<ul>${chunk}</ul>`)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.split(/\n{2,}/).map((part) => /^(<h[1-3]|<pre|<ul|<blockquote)/.test(part) ? part : `<p>${part.replace(/\n/g, '<br>')}</p>`).join('');
  return html.replace(/@@BLOCK(\d+)@@/g, (_, index) => blocks[Number(index)]);
}
function renderSidebar() {
  listEl.replaceChildren();
  conversations.forEach((conversation) => {
    const item = document.createElement('div');
    item.className = `conversation-item${conversation.id === activeId ? ' active' : ''}`;
    const title = document.createElement('span'); title.textContent = `◷  ${conversation.title || 'New conversation'}`;
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.title = 'Delete conversation';
    remove.addEventListener('click', (event) => { event.stopPropagation(); conversations = conversations.filter((c) => c.id !== conversation.id); if (activeId === conversation.id) activeId = null; persist(); renderSidebar(); renderConversation(); });
    item.append(title, remove); item.addEventListener('click', () => { activeId = conversation.id; renderSidebar(); renderConversation(); $('#sidebar').classList.remove('open'); });
    listEl.append(item);
  });
}
function messageNode(message) {
  const row = document.createElement('article'); row.className = `message ${message.role}`;
  const avatar = document.createElement('div'); avatar.className = 'message-avatar'; avatar.textContent = message.role === 'user' ? 'Y' : '✳';
  const body = document.createElement('div'); body.className = 'message-body'; body.innerHTML = markdown(message.content || '');
  row.append(avatar, body); return row;
}
function renderConversation() {
  const conversation = activeConversation();
  messagesEl.replaceChildren();
  const hasMessages = Boolean(conversation?.messages?.length);
  welcomeEl.hidden = hasMessages;
  messagesEl.classList.toggle('visible', hasMessages);
  if (conversation) conversation.messages.forEach((message) => messagesEl.append(messageNode(message)));
  $('#model-name').textContent = window.agentModel || 'Assistant';
  messagesEl.parentElement.scrollTop = messagesEl.parentElement.scrollHeight;
}
function newConversation() { activeId = null; renderSidebar(); renderConversation(); promptEl.focus(); }
function setBusy(value) { busy = value; sendButton.disabled = value; sendButton.innerHTML = value ? '<span>■</span>' : '<span>↑</span>'; }
function scrollToBottom() { const area = $('#chat-area'); area.scrollTop = area.scrollHeight; }
async function sendMessage(text) {
  if (busy || !text.trim()) return;
  await configReady;
  let accessPassword = null;
  if (window.accessRequired) {
    accessPassword = sessionStorage.getItem('northstar.access_password');
    if (!accessPassword) {
      accessPassword = window.prompt('Enter the website access password:');
      if (!accessPassword) return;
      sessionStorage.setItem('northstar.access_password', accessPassword);
    }
  }
  let conversation = activeConversation();
  if (!conversation) {
    conversation = { id: crypto.randomUUID(), title: text.trim().slice(0, 42), messages: [], updatedAt: Date.now() };
    conversations.unshift(conversation); activeId = conversation.id;
  }
  conversation.messages.push({ role: 'user', content: text.trim() }); conversation.updatedAt = Date.now();
  persist(); renderSidebar(); renderConversation(); promptEl.value = ''; resizeInput(); setBusy(true);
  const assistant = { role: 'assistant', content: '' }; conversation.messages.push(assistant);
  const row = messageNode(assistant); messagesEl.append(row); messagesEl.classList.add('visible'); welcomeEl.hidden = true;
  const body = row.querySelector('.message-body'); body.innerHTML = '<div class="typing"><i></i><i></i><i></i></div>'; scrollToBottom();
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (accessPassword) headers.Authorization = `Bearer ${accessPassword}`;
    const response = await fetch('/api/chat/stream', { method: 'POST', headers, body: JSON.stringify({ messages: conversation.messages.slice(0, -1) }) });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      if (response.status === 401) sessionStorage.removeItem('northstar.access_password');
      throw new Error(failure.detail || `Request failed (${response.status}).`);
    }
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let firstDelta = true;
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n'); buffer = events.pop() || '';
      for (const eventText of events) {
        const event = eventText.match(/^event: (.+)$/m)?.[1]; const dataLine = eventText.match(/^data: (.+)$/m)?.[1]; if (!dataLine) continue;
        const data = JSON.parse(dataLine);
        if (event === 'delta') { if (firstDelta) { body.innerHTML = ''; firstDelta = false; } assistant.content += data.text; body.innerHTML = markdown(assistant.content); scrollToBottom(); }
        if (event === 'error') { body.innerHTML = `<div class="error-note">${escapeHtml(data.message)}</div>`; assistant.content = ''; }
      }
    }
    if (!assistant.content && !body.querySelector('.error-note')) body.innerHTML = '<span class="error-note">The model returned an empty response.</span>';
  } catch (error) {
    body.innerHTML = `<div class="error-note">${escapeHtml(error.message || 'Something went wrong. Please try again.')}</div>`; assistant.content = '';
  } finally { conversation.messages = conversation.messages.filter((message) => message.role !== 'assistant' || message.content); persist(); setBusy(false); }
}
function resizeInput() { promptEl.style.height = 'auto'; promptEl.style.height = `${Math.min(promptEl.scrollHeight, 180)}px`; }

$('#composer').addEventListener('submit', (event) => { event.preventDefault(); sendMessage(promptEl.value); });
promptEl.addEventListener('input', resizeInput);
promptEl.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#composer').requestSubmit(); } });
$('#new-chat').addEventListener('click', newConversation);
$('#settings-open').addEventListener('click', () => $('#settings-dialog').showModal());
$('#clear-history').addEventListener('click', () => { conversations = []; activeId = null; persist(); renderSidebar(); renderConversation(); $('#settings-dialog').close(); });
$('#mobile-menu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$('#theme-toggle').addEventListener('click', () => { document.documentElement.classList.toggle('light'); localStorage.setItem('northstar.theme', document.documentElement.classList.contains('light') ? 'light' : 'dark'); });
document.querySelectorAll('.suggestion').forEach((button) => button.addEventListener('click', () => sendMessage(button.dataset.prompt)));
document.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); newConversation(); } });
if (localStorage.getItem('northstar.theme') === 'light') document.documentElement.classList.add('light');
const configReady = fetch('/api/health').then((response) => response.json()).then((health) => { window.agentModel = health.model; window.accessRequired = health.access_required; $('#model-name').textContent = health.model; $('#settings-model').textContent = health.model; }).catch(() => {});
renderSidebar(); renderConversation();
