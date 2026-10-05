#!/usr/bin/env python3
"""Real headless Wayland/X11 software acceptance; never a physical Pi claim."""
import os, pathlib, subprocess, sys, tempfile, time

binary = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else pathlib.Path('/work/dist/desktop-tests')
# Run as a normal desktop user, with standard /run/user/UID session sockets.
if os.getuid() == 0:
    raise SystemExit('Run desktop acceptance as an unprivileged test user.')
runtime = pathlib.Path('/run/user/' + str(os.getuid()))
runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
for backend in ['wayland', 'x11']:
    env = dict(os.environ, XDG_RUNTIME_DIR=str(runtime), OPENLAUNCH_TEST_DESKTOP=backend)
    if backend == 'wayland':
        env.update(WLR_BACKENDS='headless', WLR_RENDERER='pixman', WLR_LIBINPUT_NO_DEVICES='1', WAYLAND_DISPLAY='wayland-0')
        argv = ['labwc']
        ready = runtime / 'wayland-0'
    else:
        env['DISPLAY'] = ':98'
        argv = ['Xvfb', ':98', '-screen', '0', '1280x720x24', '-nolisten', 'tcp', '-ac']
        ready = pathlib.Path('/tmp/.X11-unix/X98')
    with tempfile.TemporaryFile() as log:
        desktop = subprocess.Popen(argv, env=env, stdout=log, stderr=log)
        terminal = None
        try:
            for _ in range(100):
                if ready.exists():
                    break
                if desktop.poll() is not None:
                    log.seek(0)
                    raise RuntimeError('Desktop failed: ' + log.read().decode(errors='replace')[-2000:])
                time.sleep(.05)
            else:
                raise RuntimeError('Desktop did not start')
            with tempfile.TemporaryDirectory() as work:
                received = pathlib.Path(work) / 'input.txt'
                # The fixed local test command records keyboard delivery to a
                # real focused terminal. No test endpoint or simulated handler.
                command = 'cat > ' + str(received)
                if backend == 'wayland':
                    terminal_args = ['foot', '--maximized', '--title=openlaunch-desktop-test', '/bin/sh', '-c', command]
                else:
                    terminal_args = ['xterm', '-title', 'openlaunch-desktop-test', '-geometry', '160x45+0+0', '-e', '/bin/sh', '-c', command]
                terminal = subprocess.Popen(terminal_args, env=env, stdout=log, stderr=log)
                time.sleep(1)
                if backend == 'x11':
                    subprocess.run(['xdotool', 'search', '--name', 'openlaunch-desktop-test', 'windowfocus', '--sync'], env=env, check=True)
                subprocess.run([str(binary), '-test.v', '-test.run', '^TestActualDesktopSession$'], env=env, check=True, timeout=60)
                for _ in range(40):
                    if received.exists() and '-safe leading option text' in received.read_text():
                        break
                    time.sleep(.05)
                else:
                    log.seek(0)
                    raise RuntimeError('Keyboard input did not reach the real terminal (' + repr(received.read_text() if received.exists() else 'missing') + '): ' + log.read().decode(errors='replace')[-2000:])
        finally:
            if terminal is not None:
                terminal.terminate()
                terminal.wait(timeout=5)
            desktop.terminate()
            try:
                desktop.wait(timeout=5)
            except subprocess.TimeoutExpired:
                desktop.kill()
                desktop.wait()
print('PASS: actual headless labwc Wayland and Xvfb screenshots, cursor, clicks, scroll and keyboard; no physical Pi claim')
