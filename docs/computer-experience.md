# Computer and Files

The bot uses a real Linux desktop. `screenshot` captures its entire X11 display,
including native windows; Chromium is one app on that display.

## Watch or take control

Select a bot and open **Computer → Watch desktop**. This explicitly starts the
computer if necessary, then displays a continuous desktop stream and the remote
mouse pointer. Watch does not send keyboard or mouse input. To interact, wait for
the bot to finish (or explicitly stop its run), then choose **Take control**.
Click the desktop to focus it and use your keyboard/mouse. Switch back to Watch
or Disconnect to release control. Watch survives brief panel/browser-tab switches;
after 30 seconds away it pauses and automatically resumes when you return.
Network interruption or an expired desktop grant reconnects with fresh view-only
access without signing you out. Closing the Computer pane, Disconnect, changing
bots, logout or Suspend stops watching. Manual control releases immediately when
the page/pane is hidden and must always be taken again explicitly.

The bot can click at desktop coordinates using the left, right or middle button,
and scroll at the current pointer. Watching never blocks those tools. A human
control lease temporarily blocks bot mutations to avoid competing input; releasing
control restores bot access. Native hover/move-only and drag tools are not yet
exposed by the agent tool set.

Full screen is available where the browser supports it. Screenshots, terminal and
manual controls remain under **Snapshots, terminal & manual tools**. These are
explicit actions; the live viewer does not repeatedly invoke the screenshot tool.
Save checkpoint saves portable workspace files; Suspend saves and stops processes.
A live connection keeps the computer running until it disconnects.

If an already running computer reports an older image, wait for its work to
finish, choose **Suspend**, then reconnect. Its saved workspace is restored.

## Inspect a workspace

**Files** opens directories and source with syntax highlighting and line numbers.
Raster images render as images; HTML and SVG are displayed as source rather than
executed. Other binary formats have metadata and download. Large text previews
show their limit explicitly (256 KiB); downloads support files up to 32 MiB.

Each discovered Git repository gets a project card showing its path, branch or
detached HEAD, and staged/modified/untracked counts. Select a project, then a
changed file, to switch between source, working changes and staged changes.
Refresh explicitly to pick up ongoing agent edits. This explorer is read-only;
use the bot or the explicit quick file editor for changes.

## Implementation

The console uses noVNC with authenticated WebSockets; x11vnc serves the existing
X11 display. Separate view-only and control transports enforce access on the
server. A short-lived bot-bound ticket and expiring control lease are owned by
ComputerDO; neither the account credential nor transport credential enters a URL
or the bot transcript. Control ports cannot be published as workspace apps.

CUA's separation of agent harness and computer driver is relevant to Timber, but
this feature does not replace Pi or Cloudflare with another provider. The live
viewer and the filesystem/Git inspection API are independent of the agent engine.

## Verification

Automated coverage includes owner authentication, bot isolation, ticket replay,
exclusive control, lease expiry, mutation fencing, restricted app ports, workspace
path containment, safe Git inspection, actual noVNC/RFB negotiation in Chromium,
rendered framebuffer pixels, keyboard/mouse, navigation cleanup, code highlighting,
diffs and responsive layouts. The image workflow tests a real X11 desktop,
including cursor movement and a native xterm window, after checkpoint restoration.

Recovery regressions exercise real noVNC sockets through tab/panel changes,
mobile background return, socket loss, network return, transient heartbeat errors,
desktop versus account expiry, explicit Suspend and control-to-Watch recovery.
Backend checks prove mouse actions work with viewers attached, remain fenced by
human control, and lease renewal proceeds during a blocked workspace inspection.

CI for `de80c8758fac8d6742f2a7d25fa15838aba6da00` passed backend/typechecks,
48 console browser cases, both real desktop image checks, and Worker bundling.
