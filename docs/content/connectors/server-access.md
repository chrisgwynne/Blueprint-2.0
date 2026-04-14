---
title: "Server Access (SSH/FTP)"
description: "Connect servers via SSH or FTP to monitor disk usage, memory, CPU load, and uptime."
---

# Server Access (SSH/FTP)

The Server Access connector monitors Linux servers via SSH or FTP, collecting disk usage, memory, CPU load averages, and uptime. Blueprint uses this data to raise infrastructure alerts before problems affect your site or business.

## Authentication options

### SSH (recommended)

Key-based authentication using a private key. Blueprint stores the private key encrypted using your `ENCRYPTION_KEY` environment variable.

> [!WARNING]
> Never use your root SSH key. Create a dedicated read-only monitoring user on the server:
> ```bash
> useradd -r -s /usr/sbin/nologin blueprint-monitor
> mkdir -p /home/blueprint-monitor/.ssh
> # Add your public key to authorized_keys
> ```

### FTP

Username and password. Useful for shared hosting where SSH is unavailable. FTP only collects disk usage (via directory listing sizes) — CPU and memory monitoring requires SSH.

## Adding the connector

1. Go to **Connectors → Add connector → Server Access**
2. Choose **SSH** or **FTP**
3. Enter:
   - **Host**: server IP or hostname
   - **Port**: 22 for SSH (default), 21 for FTP
   - **Username**: your monitoring user
   - **Private key** (SSH) or **password** (FTP)
4. Blueprint runs a test connection and displays current disk usage

You can add multiple Server Access connectors for different servers.

## What Blueprint tracks (SSH)

| Metric | Description |
|--------|-------------|
| `disk_usage_pct` | Disk usage percentage on `/` (root mount) |
| `disk_usage_gb` | Used disk space in GB |
| `disk_free_gb` | Free disk space in GB |
| `memory_usage_pct` | RAM usage percentage |
| `memory_used_mb` | Used RAM in MB |
| `cpu_load_1m` | 1-minute CPU load average |
| `cpu_load_5m` | 5-minute CPU load average |
| `cpu_load_15m` | 15-minute CPU load average |
| `uptime_seconds` | Server uptime |

## Commands executed

Blueprint runs these read-only commands over SSH:

```bash
df -h /          # Disk usage
free -m          # Memory usage
cat /proc/loadavg  # CPU load averages
cat /proc/uptime   # Uptime
```

No data is written to the server. No packages are installed.

## Signal rules

| Signal ID | Trigger | Severity |
|-----------|---------|----------|
| `server_disk_critical` | Disk usage > 90% | critical |
| `server_disk_warning` | Disk usage > 75% | warning |
| `server_memory_warning` | Memory usage > 85% | warning |
| `server_load_high` | 5m load average > number of CPU cores × 2 | warning |

> [!TIP]
> `server_disk_critical` routes to the Sentinel agent, which will propose cleanup tasks (log rotation, old backup removal) or alert you to add disk space.

## Stale threshold

15 minutes. Infrastructure metrics change quickly — Blueprint checks every 15 minutes by default. You can increase this in connector settings if the polling rate is too aggressive for your server.

## Multiple servers

Each server is a separate connector instance. Blueprint will show disk/memory status for all connected servers on the System Health page.

## Security considerations

- SSH private keys are stored encrypted in Blueprint's SQLite database using AES-256
- The monitoring user should have no shell (`/usr/sbin/nologin`) and no sudo access
- Restrict the monitoring user to only their home directory using `chroot` if your security policy requires it
- Blueprint never executes commands that write data to the server

## Troubleshooting

**"SSH connection refused"**  
Check that SSH is running (`systemctl status sshd`) and that the port is correct. Some hosts use a non-standard port (e.g. 2222).

**"Permission denied (publickey)"**  
The public key is not in the monitoring user's `~/.ssh/authorized_keys`, or file permissions are wrong. Fix:
```bash
chmod 700 /home/blueprint-monitor/.ssh
chmod 600 /home/blueprint-monitor/.ssh/authorized_keys
chown -R blueprint-monitor: /home/blueprint-monitor/.ssh
```

**"Host key verification failed"**  
Blueprint stores the host key on first connection. If the server was rebuilt, its host key changed. Delete the connector and re-add it to accept the new key.

**Disk alerts on `/boot` not `/`**  
If your server has a separate `/boot` partition that's filling up, the `server_disk_critical` signal triggers on the root partition. Add a second connector pointing to the same server and configure it to monitor `/boot` in advanced settings.
