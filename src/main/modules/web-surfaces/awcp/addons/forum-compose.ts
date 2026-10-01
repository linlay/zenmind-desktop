/** Serialized into the guest. All helpers must remain inside this function. */
export function createForumComposeHandlers() {
  type Draft = { title: string; bodyMarkdown: string; type: string; section: string; tags: string[] };
  let busy = false;
  let uncertain = false;
  let reviewed: { token: string; draft: Draft } | undefined;
  const failure = (code: string, message: string, details?: unknown) => ({ ok: false as const, error: { code, message, ...(details === undefined ? {} : { details }) } });
  const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  function form() {
    const node = document.querySelector<HTMLFormElement>('form.forum-compose');
    if (location.pathname !== '/forum/new' || !node) throw Error('Open the forum new-post editor before using compose actions.');
    return node;
  }
  function field<T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement = HTMLInputElement>(selector: string): T {
    const node = form().querySelector<T>(selector);
    if (!node || node.disabled || ('readOnly' in node && node.readOnly)) throw Error('The expected editable form field is unavailable.');
    return node;
  }
  function set(node: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
    const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }
  async function editor() {
    const f = form();
    const button = [...f.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === 'Markdown 源码');
    if (button) { button.click(); await tick(); }
    return field<HTMLTextAreaElement>('#forum-compose-body');
  }
  async function sections(signal: AbortSignal) {
    const response = await fetch('/forum/api/v1/sections', { credentials: 'same-origin', redirect: 'error', signal });
    if (!response.ok) throw Error('Could not read available forum sections.');
    const result = await response.json();
    if (!Array.isArray(result.items)) throw Error('Unexpected forum sections response.');
    return result.items as Array<{ id: number; parentId?: number; slug: string; name: string; canPost: boolean }>;
  }
  function sectionPath(item: { id: number; parentId?: number; name: string }, items: Awaited<ReturnType<typeof sections>>) {
    const names = [item.name]; const visited = new Set([item.id]);
    while (item.parentId) {
      const parent = items.find(candidate => candidate.id === item.parentId);
      if (!parent || visited.has(parent.id)) throw Error('Invalid section hierarchy.');
      names.unshift(parent.name); visited.add(parent.id); item = parent;
    }
    return names.join(' / ');
  }
  async function read(signal: AbortSignal): Promise<Draft> {
    const body = await editor();
    const items = await sections(signal);
    const label = field<HTMLButtonElement>('.forum-section-trigger').querySelector('span')?.textContent?.trim();
    const matches = items.filter(item => item.canPost && sectionPath(item, items) === label);
    if (matches.length !== 1) throw Error('Select one unambiguous publishable section.');
    // Current compose actions intentionally handle text only. Do not drop uploaded media.
    if (form().querySelector('img, .forum-upload-previews, .forum-attachments, a[href*="/attachments/"]')) throw Error('Compose AWCP currently supports text-only posts; remove media before continuing.');
    return { title: field<HTMLInputElement>('input[maxlength="200"]').value,
      bodyMarkdown: body.value, type: field<HTMLSelectElement>('.forum-form-grid select').value,
      section: matches[0].slug, tags: [...new Set(field<HTMLInputElement>('input[placeholder^="最多 5 个"]').value.split(/[,，\s]+/).filter(Boolean))] };
  }
  async function fill(args: Record<string, unknown>, signal: AbortSignal) {
    reviewed = undefined;
    await editor();
    if (args.section !== undefined) {
      const items = await sections(signal); const item = items.find(item => item.slug === args.section && item.canPost);
      if (!item) throw Error('The selected section is unavailable for posting.');
      const trigger = field<HTMLButtonElement>('.forum-section-trigger');
      if (trigger.getAttribute('aria-expanded') !== 'true') { trigger.click(); await tick(); }
      set(field<HTMLInputElement>('.forum-section-popover input[type="search"]'), item.name); await tick();
      const candidates = [...form().querySelectorAll<HTMLButtonElement>('.forum-section-option[aria-pressed]')].filter(button => button.querySelector('span')?.textContent === item.name);
      if (candidates.length !== 1) throw Error('The section picker is ambiguous; select the section in the page.');
      candidates[0].click(); await tick();
    }
    for (const [key, selector] of [['type', '.forum-form-grid select'], ['title', 'input[maxlength="200"]'], ['bodyMarkdown', '#forum-compose-body'], ['tags', 'input[placeholder^="最多 5 个"]']]) {
      if (args[key] === undefined) continue;
      if (signal.aborted) throw Error('Compose action cancelled.');
      set(field(selector), key === 'tags' ? (args.tags as string[]).join(' ') : args[key] as string); await tick();
    }
    const draft = await read(signal);
    for (const key of Object.keys(args)) if (JSON.stringify(draft[key as keyof Draft]) !== JSON.stringify(args[key])) throw Error('The page did not retain the requested field value. Read the draft before retrying.');
    reviewed = { token: crypto.randomUUID(), draft };
    return { ok: true as const, result: { draft, draftToken: reviewed.token, published: false } };
  }
  async function invoke(action: string, args: Record<string, unknown>, signal: AbortSignal) {
    if (busy) return failure('action.compose_busy', 'Another compose action is running.');
    if (uncertain) return failure('action.publish_unknown', 'The native publish action was already dispatched. Check the page result; do not click again.');
    busy = true;
    try {
      if (action === 'forum.compose.fill') return await fill(args, signal);
      const draft = await read(signal);
      if (!reviewed || reviewed.token !== args.draftToken || JSON.stringify(reviewed.draft) !== JSON.stringify(draft)) return failure('action.draft_changed', 'Fill the current draft again and review it before publishing.');
      if (!draft.title.trim() || !draft.bodyMarkdown.trim() || draft.title.length > 200 || draft.bodyMarkdown.length > 50000 || draft.tags.length > 5) return failure('invalid_arguments', 'Title, body and at most five tags are required.');
      if (signal.aborted) throw Error('Compose action cancelled.');
      const currentForm = form();
      const button = field<HTMLButtonElement>('.forum-primary');
      if (button.form !== currentForm || button.type !== 'submit') return failure('action.compose_unavailable', 'The native publish button is not the expected form submitter.');
      if (!currentForm.reportValidity()) return failure('action.form_invalid', 'The page form validation rejected submission. No publish click was dispatched.');
      let submitted = false;
      const observe = (event: Event) => { if (event.target === currentForm && (event as SubmitEvent).submitter === button) submitted = true; };
      currentForm.addEventListener('submit', observe, true);
      // The original site's click/submit handler owns validation, auth, CSRF,
      // network requests and navigation. Never recreate its POST in the bridge.
      uncertain = true; reviewed = undefined;
      try { button.click(); } finally { currentForm.removeEventListener('submit', observe, true); }
      if (!submitted) return failure('action.publish_unknown', 'The publish button was clicked but no matching form submit event was observed. Inspect the page before trying again.');
      return { ok: true as const, result: {
        status: 'submitted', published: null,
        message: 'The native publish button dispatched the form submission. Server completion is not yet confirmed. Observe the resulting page or validation message; do not repeat this action.'
      } };
    } catch (error) {
      return failure(uncertain ? 'action.publish_unknown' : 'action.compose_unavailable', uncertain ? 'Publish result is unknown; check server state before retrying.' : (error as Error).message);
    } finally { busy = false; }
  }
  return Object.fromEntries(['forum.compose.fill', 'forum.compose.publish'].map(action => [action, (args: Record<string, unknown>, signal: AbortSignal) => invoke(action, args, signal)]));
}
