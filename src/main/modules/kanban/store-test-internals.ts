import { DATABASE_DIRECTORY, DATABASE_FILENAME } from "./store-values";
import { getDesktopKanbanDatabasePath, withDesktopKanbanDatabase } from "./store-database";

export const __testInternals = {
  DATABASE_DIRECTORY,
  DATABASE_FILENAME,
  getDesktopKanbanDatabasePath,
  withDesktopKanbanDatabase
};
