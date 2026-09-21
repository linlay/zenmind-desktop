import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { executeKanbanAction } = require('../dist-electron/main/modules/desktop-actions/kanban-actions.js');

test('Kanban errors identify exact fields before any mutation on either platform', async () => {
  for (const platform of ['darwin', 'win32']) {
    let mutations = 0;
    const options = { platform, getKanbanRuntime: () => ({
      createIssue: async input => { mutations++; return { ok: true, issue: input }; },
      moveIssue: async input => { mutations++; return { ok: true, issue: input }; }
    }) };
    for (const args of [{ title: 'private text' }, { issue: { title: 'private text' } }, { input: [] }]) {
      const result = await executeKanbanAction(options, 'desktop.kanban.createIssue', args);
      assert.equal(result.error.code, 'invalid_args');
      assert.equal(result.error.details.issues[0].path, 'args.input');
      assert.ok(!JSON.stringify(result).includes('private text'));
    }
    const result = await executeKanbanAction(options, 'desktop.kanban.moveIssue', { input: { id: 'x', status: 'todo', position: 1 } });
    assert.deepEqual(result.error.details.issues.map(x => x.path), ['args.id', 'args.status', 'args.position']);
    const invalid = await executeKanbanAction(options, 'desktop.kanban.createIssue', { input: { title: '', status: 'pending', workflowId: 'x', typeId: 'x', position: 1 } });
    assert.equal(invalid.error.details.issues.length, 5);
    assert.equal(mutations, 0);
    const created = await executeKanbanAction(options, 'desktop.kanban.createIssue', { input: { title: 'Weather', status: 'todo', assigneeAgentKey: 'cutej' } });
    assert.equal(created.ok, true);
    assert.equal(created.result.issue.assigneeAgentKey, 'cutej');
    const moved = await executeKanbanAction(options, 'desktop.kanban.moveIssue', { id: 'x', status: 'todo', position: 1.5 });
    assert.equal(moved.ok, true);
    assert.equal(mutations, 2);
  }
});
