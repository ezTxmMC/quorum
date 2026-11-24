# Quorum compatibility patch

Upstream xattr 0.2.3 (MIT / Apache-2.0) is required by GPUI 0.2.2 through
zed-async-tar. On Linux and Android, use libc::ENODATA for a missing extended
attribute. The obsolete libc::ENOATTR alias was removed in current libc.
macOS and BSD continue to use libc::ENOATTR. No other library code is changed. Upstream tests use the system temporary
directory instead of hardcoding /var/tmp, so they work in restricted build environments.

This Cargo patch is local to the native desktop manifest. Do not edit the
user Cargo registry or substitute ENOSTR (a different error).
