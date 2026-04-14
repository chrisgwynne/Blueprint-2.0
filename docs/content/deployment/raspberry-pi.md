---
title: "Raspberry Pi"
description: "Running Blueprint on a Raspberry Pi for a fully local setup"
section: "Deployment"
order: 4
---

# Raspberry Pi

Blueprint runs on a Raspberry Pi, giving you a self-hosted business OS that lives entirely on your local network with no cloud dependency. This page covers hardware selection, OS setup, performance considerations, and how to run Blueprint as a service that starts automatically on boot.

---

## Hardware Recommendations

| Model | RAM | Verdict |
|-------|-----|---------|
| Pi 5 (4GB or 8GB) | 4–8 GB | Excellent. Handles Blueprint comfortably alongside other services. |
| Pi 4 (4GB) | 4 GB | Recommended minimum. Runs Blueprint well with no other heavy processes. |
| Pi 4 (2GB) | 2 GB | Workable, but leave headroom — don't run other heavy services alongside Blueprint. |
| Pi 4 (1GB) | 1 GB | Marginal. SQLite queries and agent runs will be slow under load. |
| Pi 3 / Pi 4 (512MB) | 512 MB | Not recommended. Insufficient RAM for the Node/Bun process plus SQLite. |

**The Pi 4 (4GB) is the practical minimum for a comfortable experience.** The Pi 5 is a meaningful step up — faster CPU means agent JSON parsing and DB queries complete in half the time.

---

## Operating System

Use a **64-bit** OS. Bun and modern Node.js do not support 32-bit ARM.

**Recommended options:**
- **Raspberry Pi OS Lite (64-bit)** — headless, minimal footprint, most common choice for a server Pi. Download from the [Raspberry Pi website](https://www.raspberrypi.com/software/operating-systems/).
- **Raspberry Pi OS (64-bit) with desktop** — if you want a GUI alongside Blueprint.
- **Ubuntu Server 22.04 LTS (64-bit ARM)** — a familiar alternative if you're more comfortable with Ubuntu.

Use the **Raspberry Pi Imager** to flash the OS. In the imager's advanced settings, pre-configure your Wi-Fi credentials and enable SSH — this means you won't need a keyboard or monitor attached.

---

## Install Bun

The version of Node.js available in the default Raspberry Pi OS `apt` repository is too old (typically Node 12 or 16). Do not use `apt install nodejs`. Instead, install Bun — it includes its own JavaScript runtime and does not depend on system Node.

```bash
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
bun --version
```

If you prefer Node.js over Bun, install a current version via NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version  # should print v20.x.x
```

---

## LLM Configuration

Running an LLM locally on the Pi is possible but slow. Here's a realistic breakdown:

**Ollama on the Pi itself:**
- Pi 4 with a small model (e.g., `gemma3:4b` or `phi3:mini`): expect **4–8 seconds per token**. A single agent run producing 500 tokens will take 35–70 minutes. Not practical for daily use.
- Pi 5 is roughly 2× faster, but still slow for anything bigger than a 4B parameter model.

**Recommended approach — use a remote LLM provider:**

The easiest option is to use Anthropic or OpenAI. Blueprint sends data to their APIs and the processing happens on their infrastructure. Your data never leaves your network except for the API calls themselves.

```bash
# In your .env on the Pi:
ANTHROPIC_API_KEY=sk-ant-...
```

**Alternative — Ollama on a more powerful machine on the same network:**

If you have a desktop or server with a GPU (or a Mac with Apple Silicon), run Ollama there and point Blueprint at it:

```bash
# On the machine running Ollama, bind to all interfaces:
OLLAMA_HOST=0.0.0.0 ollama serve

# In your Blueprint .env on the Pi:
OLLAMA_BASE_URL=http://192.168.1.50:11434
```

Replace `192.168.1.50` with the IP address of the machine running Ollama. Blueprint will send LLM requests to that machine over the local network — fast, local, and no external API costs.

---

## Setup

The setup process is identical to bare metal. SSH into your Pi and run:

```bash
git clone https://github.com/your-org/blueprint.git
cd blueprint
bun run setup
cp .env.example .env
nano .env  # fill in ENCRYPTION_KEY, SESSION_SECRET, ADMIN_PASSWORD, and LLM settings
bun run db:init
cd client && bun run build && cd ..
```

---

## Performance Tips

### Use an SSD, not the SD card

SD cards have poor random-write performance, which significantly slows SQLite (which does many small random writes). A USB 3.0 SSD is a substantial improvement — Blueprint feels noticeably snappier.

Move the database to the SSD by setting `DATABASE_PATH` in your `.env`:

```bash
DATABASE_PATH=/mnt/ssd/blueprint.db
```

Make sure the SSD is mounted at `/mnt/ssd` in `/etc/fstab` so it persists across reboots. To find the UUID of your SSD:

```bash
sudo blkid
```

Add to `/etc/fstab`:

```
UUID=your-ssd-uuid /mnt/ssd ext4 defaults,noatime 0 2
```

### Reduce GPU memory allocation

Blueprint does not use the Pi's GPU at all. The default GPU memory split reserves 76MB or more for the GPU — this can be reclaimed for the main CPU.

Edit `/boot/config.txt` (or `/boot/firmware/config.txt` on newer Pi OS):

```ini
gpu_mem=16
```

This reduces the GPU memory reservation to the minimum (16MB), giving Blueprint an extra ~60MB of usable RAM. Reboot after making this change.

### Increase swap space

The default Pi OS swap is 100MB — too small if you're running Blueprint on a 1GB or 2GB Pi. Increase it to 2GB:

```bash
sudo dphys-swapfile swapoff
sudo nano /etc/dphys-swapfile
# Change CONF_SWAPSIZE=100 to CONF_SWAPSIZE=2048
sudo dphys-swapfile setup
sudo dphys-swapfile swapon
```

> [!NOTE]
> Swap on an SD card is slow and increases card wear. If you have an SSD attached, consider setting the swap file location to the SSD instead.

---

## Static IP Address

For reliable local access, give your Pi a static IP address.

**Option 1 — DHCP reservation in your router (recommended).** Log into your router, find the DHCP client list, identify your Pi's MAC address, and assign it a permanent IP lease. The exact steps depend on your router firmware.

**Option 2 — Static IP in `/etc/dhcpcd.conf`:**

```bash
sudo nano /etc/dhcpcd.conf
```

Add at the end (adjust for your network):

```
interface eth0
static ip_address=192.168.1.100/24
static routers=192.168.1.1
static domain_name_servers=192.168.1.1 8.8.8.8
```

Reboot after editing. Confirm the IP has taken effect with `ip addr`.

---

## Accessing Blueprint on Your Home Network

Once running, Blueprint is available at:

```
http://[pi-ip-address]:4000
```

For example: `http://192.168.1.100:4000`

Any device on the same Wi-Fi or LAN can access it. To access Blueprint from outside your home network, you'll need to set up a VPN (e.g., Tailscale or WireGuard) or a reverse proxy with port forwarding — the latter exposes Blueprint to the internet and requires HTTPS and a strong password.

**Tailscale** is the easiest option for remote access: install it on both the Pi and your phone/laptop, and Blueprint becomes accessible at its Tailscale IP from anywhere without opening any ports.

---

## Auto-Start on Boot

### Option 1 — PM2 (recommended)

Install PM2 and configure it to start Blueprint when the Pi boots. See the [Bare Metal](/deployment/bare-metal) deployment guide for the full PM2 setup instructions — the steps are identical on Pi.

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 startup
# Run the command PM2 outputs
pm2 save
```

### Option 2 — systemd unit file

If you prefer not to use PM2, create a systemd service directly:

```bash
sudo nano /etc/systemd/system/blueprint.service
```

```ini
[Unit]
Description=Blueprint Business OS
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/blueprint/server
ExecStart=/home/pi/.bun/bin/bun index.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=blueprint
EnvironmentFile=/home/pi/blueprint/.env
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Adjust `User`, `WorkingDirectory`, `ExecStart`, and `EnvironmentFile` to match your setup. Find your Bun path with `which bun`.

Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable blueprint
sudo systemctl start blueprint
sudo systemctl status blueprint
```

View logs:

```bash
journalctl -u blueprint -f
```

The service will start automatically on every boot and restart itself if Blueprint crashes.
