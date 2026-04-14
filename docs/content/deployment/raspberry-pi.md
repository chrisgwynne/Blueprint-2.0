---
title: "Raspberry Pi"
description: "How to run Blueprint on a Raspberry Pi 4 or Pi 5 as an always-on local server"
section: "Deployment"
order: 4
---

# Raspberry Pi

Blueprint runs well on a Raspberry Pi 4 (4 GB or more) and Pi 5 with 64-bit Raspberry Pi OS. This makes it an excellent choice for an always-on home server — low power draw, silent, and completely self-hosted with no cloud dependency.

---

## Requirements

| Requirement | Detail |
|------------|--------|
| Hardware | Raspberry Pi 4 (4 GB+) or Pi 5 — recommended. Pi 4 2 GB works but is tight. |
| OS | 64-bit Raspberry Pi OS (Lite or Desktop) or Ubuntu Server 22.04 ARM. **Must be 64-bit.** |
| RAM | 4 GB minimum for Blueprint alone; 4 GB minimum if also running Ollama |
| Storage | Fast microSD (A2 rated) or USB SSD — SSD strongly preferred |
| Network | Static IP or DHCP reservation recommended |

> [!WARNING]
> Bun requires a 64-bit operating system. 32-bit Raspberry Pi OS (the default on older images) will not work. Use the Raspberry Pi Imager to flash a 64-bit image — look for "Raspberry Pi OS Lite (64-bit)" or "Raspberry Pi OS (64-bit)".

---

## Installation

Installation is identical to the [Bare Metal Linux](/deployment/bare-metal) guide. The steps below are a condensed version — refer to the full bare-metal guide for detailed explanations of each step.

### 1. Install Bun

```bash
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
bun --version
```

### 2. Clone and set up Blueprint

```bash
git clone https://github.com/your-org/blueprint.git /opt/blueprint
cd /opt/blueprint
bun run setup
```

### 3. Configure .env

```bash
cp .env.example .env
nano .env
# Set ENCRYPTION_KEY, SESSION_SECRET, ADMIN_PASSWORD, and LLM provider
```

### 4. Build the frontend

```bash
bun run build
```

### 5. Create a systemd service

Follow the [systemd service setup](/deployment/bare-metal#step-7--create-the-systemd-service) from the bare-metal guide exactly, substituting `pi` (or your username) for `blueprint` if you're not creating a dedicated user:

```bash
sudo systemctl enable blueprint
sudo systemctl start blueprint
```

Blueprint will be available at `http://[pi-ip]:4000` from any device on your network.

---

## Performance

### Pi 4 vs Pi 5

| Task | Pi 4 (4 GB) | Pi 5 (4 GB) |
|------|------------|------------|
| Server startup | ~4 s | ~2 s |
| Agent run (no Ollama) | ~8–15 s | ~4–8 s |
| Agent run with Ollama llama3.2:3b | ~30 s | ~10 s |
| SQLite query (typical) | <1 ms | <1 ms |
| React client build | ~90 s | ~45 s |

The Pi 4 handles Blueprint well for all standard usage — cron-triggered agent runs, dashboard browsing, and connector syncs. The Pi 5 is noticeably snappier for everything.

### Ollama on Pi

If you want fully local LLM inference on the Pi itself:

- **Pi 4 with llama3.2:3b** — approximately 30 s per agent run. Usable for overnight or low-frequency tasks.
- **Pi 5 with llama3.2:3b** — approximately 10 s per agent run. Comfortable for daily use.
- **llama3 (full, 8B)** — too slow on Pi 4 for practical daily use. On Pi 5, expect 60–90 s per run.

**Recommended Ollama models for Pi:**

```bash
# Good balance of speed and quality on Pi 4 and Pi 5
ollama pull llama3.2:3b

# Faster, smaller — good for Pi 4 with limited RAM
ollama pull phi3:mini
```

> [!TIP]
> If you have a desktop or laptop with a GPU or Apple Silicon on the same network, run Ollama there and point Blueprint at it: `OLLAMA_BASE_URL=http://192.168.1.x:11434`. Blueprint on the Pi sends requests to the remote machine — fast inference without taxing the Pi at all.

---

## Storage

### Use a USB SSD, not the microSD card

SQLite uses WAL (Write-Ahead Logging) mode, which writes frequently in small bursts. SD cards have poor random-write performance and will slow Blueprint down noticeably — especially during agent runs that write task records and update memory files.

**A USB SSD is the single most impactful hardware upgrade for a Pi running Blueprint.**

Connect a USB 3.0 SSD and either run Blueprint from it directly, or set `DATABASE_PATH` in `.env` to point the database to the SSD:

```bash
DATABASE_PATH=/mnt/ssd/blueprint.db
```

Mount the SSD persistently by adding it to `/etc/fstab`:

```bash
# Find the UUID of your SSD
sudo blkid

# Add to /etc/fstab (replace UUID with your actual value)
UUID=xxxx-xxxx  /mnt/ssd  ext4  defaults,noatime  0 2
```

Use the `noatime` option — it disables access-time tracking, which further reduces unnecessary writes on the SSD.

### If using microSD

If you are using a microSD card, use an **A2-rated** card (designed for random I/O, not just sequential). A2 cards are marketed for app performance on Android and have significantly better small-file random write speeds than standard or A1 cards.

---

## Temperature and Power

Blueprint is mostly idle between cron runs. Agent runs are short bursts of CPU activity followed by periods of near-zero load.

**Temperature:** Under normal Blueprint usage (no Ollama), a Pi 4 without a heatsink will stay below 50°C. With Ollama running, add a heatsink or small fan to avoid thermal throttling. The Pi 5 runs warmer and benefits from active cooling even at idle.

**Power draw:**
- Pi 4: approximately 5 W idle, 8–10 W under agent load
- Pi 5: approximately 5 W idle, 12 W under full load

A Pi 4 or Pi 5 running Blueprint continuously costs roughly £3–5/year in electricity at UK rates. This makes it an economical always-on server for small businesses.

---

## Static IP

Blueprint should be at a predictable address on your network. Without a static IP, the server address changes when the Pi gets a new DHCP lease, breaking bookmarks and OAuth redirect URIs.

**Option 1 — DHCP reservation (recommended).** Log into your router's admin interface, find the DHCP client list, identify the Pi's MAC address, and assign it a permanent lease. The Pi still uses DHCP but always gets the same IP.

**Option 2 — Static IP in the OS.** For Raspberry Pi OS (bookworm+), edit `/etc/dhcpcd.conf`:

```bash
sudo nano /etc/dhcpcd.conf
```

Add at the bottom (adjust for your network):

```
interface eth0
static ip_address=192.168.1.100/24
static routers=192.168.1.1
static domain_name_servers=192.168.1.1 8.8.8.8
```

Reboot and confirm: `ip addr show eth0`.

---

## Backup

All Blueprint state is in `/opt/blueprint/data/`. This directory contains the SQLite database, connector credentials, task history, and signal history. Back it up regularly.

**Simple cron backup to an external drive:**

```bash
# Mount an external drive at /media/backup
# Add to crontab: crontab -e
0 3 * * * tar -czf /media/backup/blueprint-$(date +\%Y\%m\%d).tar.gz /opt/blueprint/data
```

**Cloud backup with rclone:**

```bash
# Install rclone and configure a remote (e.g., Backblaze B2 or Google Drive)
sudo apt install rclone
rclone config  # follow the prompts to set up a remote named "backup"

# Add to crontab
0 3 * * * tar -czf /tmp/blueprint-$(date +\%Y\%m\%d).tar.gz /opt/blueprint/data && rclone copy /tmp/blueprint-*.tar.gz backup:blueprint-backups/
```

> [!NOTE]
> The SQLite database is safe to copy while Blueprint is running — WAL mode means readers and writers do not block each other. However, for a guaranteed consistent backup, stop Blueprint before archiving: `sudo systemctl stop blueprint && tar ... && sudo systemctl start blueprint`.

---

## Remote Access

By default, Blueprint is accessible on your local network only.

To access it from outside your home without opening ports:

**Tailscale (easiest):**

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Install Tailscale on your phone or laptop as well. Blueprint becomes accessible at its Tailscale IP from anywhere, through an encrypted tunnel, with no port forwarding required.

**Cloudflare Tunnel** is another option if you have a Cloudflare account — it provides a public HTTPS URL with no port exposure.
