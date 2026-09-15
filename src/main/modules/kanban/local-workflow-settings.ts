import type { KanbanCurrentUser, KanbanLocalWorkflow } from "../../../shared/contracts";
import { BOARD_ID, type AppPathProvider } from "./local-store.part-1";
import { withDesktopKanbanDatabase } from "./local-store.part-2";
import { validateLocalWorkflows } from "./local-workflows";

export function saveLocalWorkflowDefinitions(app: AppPathProvider, user: KanbanCurrentUser, input: KanbanLocalWorkflow[]) {
  const definitions = validateLocalWorkflows(input);
  withDesktopKanbanDatabase(app, user, (db) => {
    db.prepare(`INSERT INTO board_meta (BOARD_ID_, KEY_, VALUE_) VALUES (?, 'local_workflows', ?)
      ON CONFLICT(BOARD_ID_, KEY_) DO UPDATE SET VALUE_ = excluded.VALUE_`).run(BOARD_ID, JSON.stringify(definitions));
  });
}
