# omsk-gmu-calendar

Tenant repository for the **Омский государственный медицинский университет (ОмГМУ)** schedule project.

## Responsibility

This repository owns university-specific schedule integration only:

- official source discovery and download;
- parsing and normalization;
- QA and review policy;
- source/watch logic;
- tenant-specific operational integrations.

Generic customer runtime, commerce, subscriptions, trials and public schedule API belong to `gmarkov634-stack/medical-calendar-core`.

## Current migration state

The existing OmGMU adapter is still running from `gmarkov634-stack/kirov-gmu-calendar`. Migration into this repository must be staged and must not change production publication state until separately authorized.

Official schedule source currently used by the existing adapter:
`https://omsk-osma.ru/studentam/raspisanie-zanyatiy`

Tenant id: `omgmu`.
