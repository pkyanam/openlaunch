FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends labwc grim wtype xvfb scrot xdotool python3 systemd dbus-user-session xterm foot fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1000 desktop && mkdir -p /run/user/1000 && chown desktop:desktop /run/user/1000 && chmod 700 /run/user/1000
USER desktop
ENV HOME=/home/desktop XDG_RUNTIME_DIR=/run/user/1000
WORKDIR /work
ENTRYPOINT ["python3", "tests/desktop/run.py"]
