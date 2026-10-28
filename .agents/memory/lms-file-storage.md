---
name: App Storage media delivery
description: App Storage availability, private-object access, and large-media delivery.
---

This workspace now has a provisioned default App Storage bucket. The bucket remains private and has no public object URLs; media for public pages must be served through a narrowly scoped application route.

**Why:** The SDK cannot initialize until a bucket is provisioned, and its stream API does not document byte-range reads. Long videos need segmented delivery for browser seeking rather than a single proxied MP4.

**How to apply:** Verify bucket availability before initializing the SDK. Keep large assets out of Git and the site bundle, use HLS for long videos, and proxy only allowlisted objects through app routes. Keep LMS resources in the existing database when their role-based access rules require it.
