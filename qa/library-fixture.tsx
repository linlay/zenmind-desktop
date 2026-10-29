// Deterministic bridge fixture for the real Library renderer; never touches a user profile.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, theme } from 'antd';
import { ArtifactManagementPage } from '../src/renderer/pages/artifact-management/ArtifactManagementPage';
import { RendererI18nContext } from '../src/renderer/i18n/i18n-context';
import { createTranslator } from '../src/shared/i18n';
import '../src/renderer/styles.css';
const names = ['Annual report.docx', 'Landscape.png', 'Dashboard.html', 'Dataset.xlsx', 'Source project.zip', 'Demo.mp4', 'Archive report.pdf', 'Legacy.txt', 'Conflicting.txt'];
const categories = ['document', 'image', 'web', 'document', 'archive', 'media', 'document', 'document', 'document'];
const mimes = ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/png', 'text/html', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip', 'video/mp4', 'application/pdf', 'text/plain', 'text/plain'];
const folders = [{ id: 'research', name: 'Research', parentId: null }, { id: 'brand', name: 'Brand', parentId: 'research' }, { id: 'images', name: 'Images', parentId: 'brand' }, { id: 'delivery', name: 'Delivery', parentId: null }, { id: 'empty', name: 'Empty folder', parentId: null }];
const data = names.map((name, index) => ({ chatId: 'chat-' + index, runId: index === 7 ? '' : 'run-' + index, artifactId: 'artifact-' + index, name, displayName: '', folderId: ['delivery', 'images', 'brand', 'research', null, null, 'delivery', null, null][index], mimeType: mimes[index], sizeBytes: 123456, sha256: 'a'.repeat(64), pushedAt: Date.now() - index * 1000, category: categories[index], favorite: index === 1, tags: index < 3 ? ['Research'] : [], contentState: index === 7 ? 'unresolved' : index === 8 ? 'ambiguous' : 'ready', sourceState: index === 6 ? 'archived' : 'active', accessState: 'available', chatName: 'Research conversation ' + index, agentKey: 'agent' }));
let sync = { phase: 'partial', completed: 9, total: 9, failed: 1, denied: 1 };
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(fn => fn());
const qa = window.qa = { views: [], actions: [], patches: [], moves: [], queries: [], chats: [], syncs: 0, folderMutations: [], platform: 'darwin', fail: false, data, folders };
const match = (item, id) => item.chatId === id.chatId && item.runId === id.runId && item.artifactId === id.artifactId;
window.electronAPI = { settings: { getPlatform: async () => qa.platform }, assistant: { getChatInfo: async chatId => ({ chatId, agentKey: 'agent' }) }, artifacts: {
  list: async input => {
    qa.queries.push(input); if (qa.fail) throw Error('fixture failure');
    let records = data.filter(item => (!input.chatId || item.chatId === input.chatId) && (!input.favoritesOnly || item.favorite) && (!input.tag || item.tags.includes(input.tag)) && (input.folderId === undefined || item.folderId === input.folderId) && (!input.recent || item.pushedAt >= Date.now() - 3 * 86400000) && (!input.search || [item.name, item.displayName, item.chatName, ...item.tags].some(value => value.toLowerCase().includes(input.search.toLowerCase()))));
    const facets = Object.fromEntries(['image', 'web', 'document', 'media', 'archive', 'other'].map(category => [category, records.filter(item => item.category === category).length]));
    if (input.category) records = records.filter(item => item.category === input.category);
    records.sort((a, b) => input.sort === 'name' ? (a.displayName || a.name).localeCompare(b.displayName || b.name) : input.sort === 'type' ? a.category.localeCompare(b.category) || a.name.localeCompare(b.name) : b.pushedAt - a.pushedAt);
    const folderCounts = folders.map(folder => {
      const descendants = new Set([folder.id]);
      for (let i = 0; i < 20; i++) folders.forEach(child => { if (descendants.has(child.parentId)) descendants.add(child.id); });
      return { ...folder, directCount: data.filter(item => item.folderId === folder.id).length, totalCount: data.filter(item => descendants.has(item.folderId)).length, childCount: folders.filter(child => child.parentId === folder.id).length };
    });
    return structuredClone({ records: records.slice(input.offset || 0, (input.offset || 0) + (input.limit || 50)), total: records.length, tags: [...new Set(data.flatMap(item => item.tags))], folders: folderCounts, counts: { all: data.length, starred: data.filter(item => item.favorite).length, unfiled: data.filter(item => item.folderId === null).length, recent: data.filter(item => item.pushedAt >= Date.now() - 3 * 86400000).length }, categories: facets, sync });
  },
  organize: async input => { qa.patches.push(input); const item = data.find(item => match(item, input)); if (!item) throw Error('missing'); Object.assign(item, input); notify(); },
  folder: async input => {
    qa.folderMutations.push(input);
    const existing = folders.find(folder => folder.id === input.id), parentId = input.action === 'create' ? input.parentId : existing?.parentId;
    if (input.action === 'delete') { if (!existing) return { ok: false, error: 'folder_missing' }; folders.splice(folders.indexOf(existing), 1); }
    else {
      if (folders.some(folder => folder.id !== input.id && folder.parentId === parentId && folder.name.toLowerCase() === input.name.toLowerCase())) return { ok: false, error: 'duplicate_name' };
      if (input.action === 'create') folders.push({ id: 'created-' + qa.folderMutations.length, parentId, name: input.name });
      else existing.name = input.name;
    }
    notify(); return { ok: true };
  },
  organizeMany: async input => { qa.moves.push(input); input.items.forEach(id => { const item = data.find(item => match(item, id)); if (input.folderId !== undefined) item.folderId = input.folderId; if (input.favorite !== undefined) item.favorite = input.favorite; }); notify(); return { ok: true }; },
  thumbnail: async () => __LIBRARY_QA_IMAGE__,
  onChanged: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  sync: async () => { qa.syncs++; sync = { ...sync, phase: 'syncing' }; setTimeout(() => { sync = { ...sync, phase: 'complete', failed: 0, denied: 0 }; notify(); }, 150); return { ...sync }; },
  act: async input => { qa.actions.push(input); return { ok: true, agentKey: 'agent', relativePath: 'artifacts/' + input.runId + '/' + data.find(item => match(item, input)).name }; },
} };
qa.pushMany = () => { data.push(...Array.from({ length: 55 }, (_, index) => ({ ...data[0], artifactId: 'extra-' + index, name: 'Additional ' + index + '.docx', displayName: '', folderId: null }))); notify(); };
qa.notify = notify;
function Fixture() {
  const [locale, setLocale] = useState('zh-CN'), [dark, setDark] = useState(false), [instance, setInstance] = useState(0);
  qa.setLocale = setLocale;
  qa.setDark = value => { document.documentElement.dataset.theme = value ? 'dark' : 'light'; setDark(value); };
  qa.remount = () => setInstance(value => value + 1);
  return <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm }}><RendererI18nContext.Provider value={{ locale, source: 'user', t: createTranslator(locale), setLocale: async () => {} }}>
    <ArtifactManagementPage key={instance} onView={request => { qa.views.push(request); return true; }} onOpenChat={request => qa.chats.push(request)} />
  </RendererI18nContext.Provider></ConfigProvider>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture /></React.StrictMode>);
