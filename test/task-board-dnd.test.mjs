import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { closestCenter, pointerWithin } from "@dnd-kit/core";

const projectRoot = process.cwd();

function rect(left, top, width, height) {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height
  };
}

function droppableContainer(id) {
  return {
    id,
    key: id,
    data: { current: {} },
    disabled: false,
    node: { current: null },
    rect: { current: null }
  };
}

function buildCollisionArgs() {
  const droppableContainers = [
    droppableContainer("todo-issue"),
    droppableContainer("task-board-column:todo"),
    droppableContainer("task-board-column:in_progress")
  ];
  const droppableRects = new Map([
    ["todo-issue", rect(16, 56, 196, 96)],
    ["task-board-column:todo", rect(8, 8, 220, 430)],
    ["task-board-column:in_progress", rect(240, 8, 220, 430)]
  ]);

  return {
    active: {
      id: "todo-issue",
      data: { current: {} },
      rect: { current: { initial: rect(16, 56, 196, 96), translated: null } }
    },
    collisionRect: rect(128, 56, 196, 96),
    droppableRects,
    droppableContainers,
    pointerCoordinates: { x: 246, y: 104 }
  };
}

test("task board drag should prefer the column under the pointer over the closest card center", () => {
  const args = buildCollisionArgs();

  assert.equal(closestCenter(args)[0]?.id, "todo-issue");
  assert.equal(pointerWithin(args)[0]?.id, "task-board-column:in_progress");
});

test("task board uses pointer-first collisions and the whole column as the drop target", () => {
  const taskBoardPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "task-board", "TaskBoardPage.tsx"),
    "utf8"
  );

  assert.match(taskBoardPage, /function detectTaskBoardCollisions/);
  assert.match(taskBoardPage, /const pointerCollisions = pointerWithin\(args\)/);
  assert.match(taskBoardPage, /if \(pointerCollisions\.length > 0\) \{/);
  assert.match(taskBoardPage, /return pointerCollisions;/);
  assert.match(taskBoardPage, /const intersectingCollisions = rectIntersection\(args\)/);
  assert.match(taskBoardPage, /collisionDetection=\{detectTaskBoardCollisions\}/);
  assert.match(taskBoardPage, /<section[\s\S]{0,160}ref=\{setNodeRef\}/);
  assert.doesNotMatch(taskBoardPage, /<div ref=\{setNodeRef\} className="task-board-column-body">/);
});

test("task board cards expose a right-click delete menu", () => {
  const taskBoardPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "task-board", "TaskBoardPage.tsx"),
    "utf8"
  );

  assert.match(taskBoardPage, /onContextMenu=\{handleContextMenu\}/);
  assert.match(taskBoardPage, /className="task-board-card-context-menu"/);
  assert.match(taskBoardPage, /onClick=\{\(\) => void deleteIssue\(issue\)\}/);
});
