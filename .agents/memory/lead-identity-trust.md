---
name: Admissions lead identity trust
description: Phone-based lead association is not applicant authentication or proof of video attention.
---

Phone matching in the admissions journey associates contact records; it does not verify ownership and must not authorize access to an applicant's history.

**Why:** VSL registration intentionally has no OTP requirement, while the user requires private history and server-validated event association.

**How to apply:** Keep lead history admin-only. Use the server-issued session association for video capture, never an arbitrary lead ID or phone as authorization. Browser observations are signals, not proof of attention; label missing completion as unrecorded rather than asserting the person did not watch.

Ambiguous historical phone matches are intentionally unresolved, not a cleanup failure.

**Why:** The user explicitly requires preservation of historical answers without destructive deduplication.

**How to apply:** Any future resolution flow needs explicit admin review; do not bulk merge historical matches or infer old timestamps.
