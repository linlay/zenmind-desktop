If a service reports a port conflict during startup, another program is already using that port.

Use these commands to find the process:

```text
# macOS / Linux
lsof -i :PORT

# Windows
netstat -ano | findstr :PORT
```

After finding the process, close the corresponding program or change the port in the service configuration file.
