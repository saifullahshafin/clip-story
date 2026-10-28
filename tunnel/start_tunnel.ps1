# Keeps the SSH tunnel to the Clip Story server alive (laptop 127.0.0.1:8790 -> ARM 127.0.0.1:8790).
# Started at logon by the scheduled task from register_task.ps1. Reconnects forever.
while ($true) {
    & ssh.exe -N -o BatchMode=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes `
        -L 8790:127.0.0.1:8790 Hunter-A1-Flex
    Start-Sleep -Seconds 10
}
