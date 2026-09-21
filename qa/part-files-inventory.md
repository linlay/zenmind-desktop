# Part 文件盘点

盘点日期：2026-09-21。扫描仓库文件（包含隐藏文件，遵循 ignore 规则；排除 Git 元数据、node_modules、dist 和 dist-electron 生成物）。本清单是阶段性盘点，不是架构设计文档。

共 **61 个源文件、19 组**，其中 **5 个二次拆分文件**。本次仅盘点，未重命名或重组业务源码。

行数按物理文本行计算，末尾换行不另算空白行。1,000 行为软性建议，不作为拆分依据或检查失败条件。

## src/main/app/bootstrap/desktop-init.ts

| 文件 | 行数 |
| --- | ---: |
| [desktop-init.part-1.ts](../src/main/app/bootstrap/desktop-init.part-1.ts) | 709 |
| [desktop-init.part-2.ts](../src/main/app/bootstrap/desktop-init.part-2.ts) | 495 |

## src/main/app/module-registry.ts

| 文件 | 行数 |
| --- | ---: |
| [module-registry.part-1.ts](../src/main/app/module-registry.part-1.ts) | 213 |
| [module-registry.part-2.ts](../src/main/app/module-registry.part-2.ts) | 968 |

## src/main/infrastructure/filesystem/runtime-environment.ts

| 文件 | 行数 |
| --- | ---: |
| [runtime-environment.part-1.ts](../src/main/infrastructure/filesystem/runtime-environment.part-1.ts) | 577 |
| [runtime-environment.part-2.ts](../src/main/infrastructure/filesystem/runtime-environment.part-2.ts) | 603 |

## src/main/modules/agent-platform/bridge.shared.ts

| 文件 | 行数 |
| --- | ---: |
| [bridge.shared.part-1.ts](../src/main/modules/agent-platform/bridge.shared.part-1.ts) | 715 |
| [bridge.shared.part-2.ts](../src/main/modules/agent-platform/bridge.shared.part-2.ts) | 306 |

## src/main/modules/assistant/navigation-status-client.ts

| 文件 | 行数 |
| --- | ---: |
| [navigation-status-client.part-1.ts](../src/main/modules/assistant/navigation-status-client.part-1.ts) | 727 |
| [navigation-status-client.part-2.ts](../src/main/modules/assistant/navigation-status-client.part-2.ts) | 710 |
| [navigation-status-client.part-3.ts](../src/main/modules/assistant/navigation-status-client.part-3.ts) | 270 |
| [navigation-status-client.part-4.ts](../src/main/modules/assistant/navigation-status-client.part-4.ts) | 614 |

## src/main/modules/desktop-actions/runtime.ts

| 文件 | 行数 |
| --- | ---: |
| [runtime.part-1.ts](../src/main/modules/desktop-actions/runtime.part-1.ts) | 767 |
| [runtime.part-2.ts](../src/main/modules/desktop-actions/runtime.part-2.ts) | 716 |
| [runtime.part-3.ts](../src/main/modules/desktop-actions/runtime.part-3.ts) | 676 |
| [runtime.part-4.ts](../src/main/modules/desktop-actions/runtime.part-4.ts) | 679 |
| [runtime.part-5.ts](../src/main/modules/desktop-actions/runtime.part-5.ts) | 481 |
| [runtime.part-6.ts](../src/main/modules/desktop-actions/runtime.part-6.ts) | 739 |
| [runtime.part-7.ts](../src/main/modules/desktop-actions/runtime.part-7.ts) | 270 |

## src/main/modules/desktop-protocol/ws-server.ts

| 文件 | 行数 |
| --- | ---: |
| [ws-server.part-1.ts](../src/main/modules/desktop-protocol/ws-server.part-1.ts) | 747 |
| [ws-server.part-2.ts](../src/main/modules/desktop-protocol/ws-server.part-2.ts) | 681 |

## src/main/modules/identity/oidc-sso.ts

| 文件 | 行数 |
| --- | ---: |
| [oidc-sso.part-1.ts](../src/main/modules/identity/oidc-sso.part-1.ts) | 714 |
| [oidc-sso.part-2.ts](../src/main/modules/identity/oidc-sso.part-2.ts) | 704 |
| [oidc-sso.part-3.ts](../src/main/modules/identity/oidc-sso.part-3.ts) | 764 |
| [oidc-sso.part-4.ts](../src/main/modules/identity/oidc-sso.part-4.ts) | 699 |
| [oidc-sso.part-5.ts](../src/main/modules/identity/oidc-sso.part-5.ts) | 691 |
| [oidc-sso.part-6.ts](../src/main/modules/identity/oidc-sso.part-6.ts) | 578 |

## src/main/modules/identity/sso-controller.ts

| 文件 | 行数 |
| --- | ---: |
| [sso-controller.part-1.ts](../src/main/modules/identity/sso-controller.part-1.ts) | 400 |
| [sso-controller.part-2.ts](../src/main/modules/identity/sso-controller.part-2.ts) | 752 |

## src/main/modules/kanban/local-store.ts

| 文件 | 行数 |
| --- | ---: |
| [local-store.part-1.ts](../src/main/modules/kanban/local-store.part-1.ts) | 514 |
| [local-store.part-2.ts](../src/main/modules/kanban/local-store.part-2.ts) | 369 |
| [local-store.part-3.ts](../src/main/modules/kanban/local-store.part-3.ts) | 685 |
| [local-store.part-4.ts](../src/main/modules/kanban/local-store.part-4.ts) | 738 |
| [local-store.part-5.ts](../src/main/modules/kanban/local-store.part-5.ts) | 267 |

## src/main/modules/kanban/ws-client.ts

| 文件 | 行数 |
| --- | ---: |
| [ws-client.part-1.ts](../src/main/modules/kanban/ws-client.part-1.ts) | 495 |
| [ws-client.part-2.ts](../src/main/modules/kanban/ws-client.part-2.ts) | 773 |

## src/main/modules/marketplace/common.ts

| 文件 | 行数 |
| --- | ---: |
| [common.part-1.ts](../src/main/modules/marketplace/common.part-1.ts) | 706 |
| [common.part-2.ts](../src/main/modules/marketplace/common.part-2.ts) | 717 |

## src/main/modules/pet/controller.ts

| 文件 | 行数 |
| --- | ---: |
| [controller.part-1.ts](../src/main/modules/pet/controller.part-1.ts) | 622 |
| [controller.part-2.ts](../src/main/modules/pet/controller.part-2.ts) | 705 |

## src/main/modules/pet/desktop-pet.ts

| 文件 | 行数 |
| --- | ---: |
| [desktop-pet.part-1.ts](../src/main/modules/pet/desktop-pet.part-1.ts) | 737 |
| [desktop-pet.part-2.ts](../src/main/modules/pet/desktop-pet.part-2.ts) | 713 |

## src/main/modules/services/agent-webclient-host.ts

| 文件 | 行数 |
| --- | ---: |
| [agent-webclient-host.part-1.ts](../src/main/modules/services/agent-webclient-host.part-1.ts) | 655 |
| [agent-webclient-host.part-2.ts](../src/main/modules/services/agent-webclient-host.part-2.ts) | 410 |

## src/main/modules/services/manager/index.ts

| 文件 | 行数 |
| --- | ---: |
| [index.part-1.ts](../src/main/modules/services/manager/index.part-1.ts) | 359 |
| [index.part-2.ts](../src/main/modules/services/manager/index.part-2.ts) | 608 |
| [index.part-3.ts](../src/main/modules/services/manager/index.part-3.ts) | 259 |
| [index.part-4.part-1.ts](../src/main/modules/services/manager/index.part-4.part-1.ts) | 644 |
| [index.part-4.part-2.ts](../src/main/modules/services/manager/index.part-4.part-2.ts) | 824 |
| [index.part-4.part-3.ts](../src/main/modules/services/manager/index.part-4.part-3.ts) | 147 |
| [index.part-4.ts](../src/main/modules/services/manager/index.part-4.ts) | 3 |
| [index.part-5.part-1.ts](../src/main/modules/services/manager/index.part-5.part-1.ts) | 696 |
| [index.part-5.part-2.ts](../src/main/modules/services/manager/index.part-5.part-2.ts) | 349 |
| [index.part-5.ts](../src/main/modules/services/manager/index.part-5.ts) | 2 |
| [index.part-6.ts](../src/main/modules/services/manager/index.part-6.ts) | 364 |

## src/main/modules/shell/window-manager.ts

| 文件 | 行数 |
| --- | ---: |
| [window-manager.part-1.ts](../src/main/modules/shell/window-manager.part-1.ts) | 585 |
| [window-manager.part-2.ts](../src/main/modules/shell/window-manager.part-2.ts) | 794 |

## src/main/modules/webs/webapps/runtime.ts

| 文件 | 行数 |
| --- | ---: |
| [runtime.part-1.ts](../src/main/modules/webs/webapps/runtime.part-1.ts) | 453 |
| [runtime.part-2.ts](../src/main/modules/webs/webapps/runtime.part-2.ts) | 698 |

## src/main/support/manifest/manifest-utils.ts

| 文件 | 行数 |
| --- | ---: |
| [manifest-utils.part-1.ts](../src/main/support/manifest/manifest-utils.part-1.ts) | 711 |
| [manifest-utils.part-2.ts](../src/main/support/manifest/manifest-utils.part-2.ts) | 457 |

