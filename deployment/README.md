# Static deployment handoff

`make static-build` creates a content-addressed, explicitly versioned image
containing the static editor and its same-origin publishing service; a
version-named OCI archive; the rendered Quadlet; build metadata; and a
checksummed static site under `artifacts/static/`. The default alpha version is
derived from the PXT target version plus the site/server digest. Set
`RELEASE_VERSION` only when an authorized release needs a different valid OCI
tag. The image contains the site; production must not mount a source checkout
over `/site`.

The Quadlet mounts only persistent share records from
`~/.local/share/circuit-playground-makecode/shares` into the otherwise
read-only container. Each anonymous share is immutable. The service accepts at
most 8 MiB per publish, limits individual project text to 4 MiB and thumbnails
to 2 MiB, rate-limits publishers, and stops accepting new shares when the
2 GiB storage quota is reached. Back up the records without stopping the
editor with:

```sh
tar -C ~/.local/share/circuit-playground-makecode -czf makecode-shares.tar.gz shares
```

Restore only while the service is stopped, into the same service-owned path.

The generated image and Quadlet are development artifacts until the acceptance
matrix in `STATUS.md` passes. Production operations belong to the `makecode`
service account on `psychosis`; do not install them as `jim` or root.

After an authorized transfer of one version's `artifacts/static/` directory,
the service-account installation flow is:

```sh
ssh makecode@psychosis
cd /path/to/transferred/artifacts/static
sha256sum -c OCI-SHA256SUMS
archive=$(awk -F'"' '/"ociArchive":/ { print $4 }' BUILD-METADATA.json)
podman load -i "$archive"
mkdir -p ~/.config/containers/systemd
cp circuit-playground-makecode.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start circuit-playground-makecode.service
curl -fsSI http://127.0.0.1:3232/
```

Quadlet's generator creates the `default.target.wants` link from the
container file's `[Install]` section. The resulting service is generated, so
`systemctl --user enable` may reject it as transient/generated; after
`daemon-reload`, start it directly and confirm that `is-enabled` reports
`generated`. Linger must be enabled for `makecode` so the user manager and
container start during host boot.

Confirm that the response includes `Permissions-Policy: usb=(self)` and the
alpha `X-Robots-Tag`, then publish and reopen a disposable project through the
browser gate. Apache should proxy only to `127.0.0.1:3232`; the container
itself publishes no non-loopback port.

For rollback, retain the preceding content-addressed image and its rendered
Quadlet. Restore that Quadlet, run `systemctl --user daemon-reload`, and restart
the service. Do not delete the preceding image until the replacement has passed
the browser and offline checks.
