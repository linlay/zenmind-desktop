Recommended startup order for built-in services:

1. **Container hub (`agent-container-hub`)**: Start first and make sure Docker or Podman is available.
2. **agent-platform**: Depends on the container hub.
3. **identity-center**: Can start independently.

If you do not use agent features, you can start only `identity-center`.
