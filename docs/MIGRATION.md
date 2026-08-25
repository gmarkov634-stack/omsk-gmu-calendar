# OmGMU migration

Current OmGMU source/parser/watch/review logic still lives in `gmarkov634-stack/kirov-gmu-calendar`.

Migration sequence:

1. inventory existing OmGMU adapter files and tests;
2. copy tenant-specific source/parser/QA code into this repository without changing production routing;
3. prove parity with existing structural and historical regressions;
4. move source/watch/review ownership only after green CI;
5. decommission the old Kirov copy in a separately authorized production-sensitive change.

Out of scope for this repository: generic customer runtime, commerce, subscriptions and trials.

No schedule publication is authorized by repository bootstrap.
