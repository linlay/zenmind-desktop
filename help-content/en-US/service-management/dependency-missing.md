`dependency-missing` means a required dependency for the service is not satisfied. Common causes include:

- The container hub (`agent-container-hub`) needs Docker or Podman, but it is not installed or not running.
- Some services depend on other built-in services being installed first.

Check and satisfy each item in the detail card's prerequisite list.
