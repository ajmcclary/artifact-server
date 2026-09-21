# Workload and operating-fact worksheet

Copy this table into a report when you need a before/after comparison that can
be reproduced or challenged. Fill every cell with a measured value, a pinned
reference, or an explicit "unknown". Do not leave a field blank because the
value feels obvious.

| Fact | Measured or pinned value | How recorded |
| --- | --- | --- |
| Provider account / plan | | |
| Region(s) | | |
| Measured RTT to provider API (ms) | | |
| Proxy / CDN / tunnel topology | | |
| Publication size distribution (bytes) | | |
| Files per publication distribution | | |
| Retained bytes (total / per project) | | |
| Backup count and frequency | | |
| Visible review hours per day | | |
| Mutation rate (publications / hour) | | |
| Concurrent client count | | |
| Durability setting (replicas, sync) | | |
| Database pool size | | |
| Fixture identity (hash / command) | | |
| Warm vs cold state | | |

## How to use

1. Record the facts before the first baseline run.
2. Attach the completed worksheet to every performance evidence file that is
   used to justify a change or a capacity claim.
3. Re-measure RTT, warm/cold state, and fixture identity for each run; the
   others only change when the deployment or workload changes.
4. If a value is "unknown", treat the corresponding performance claim as
   unqualified until it is filled.
