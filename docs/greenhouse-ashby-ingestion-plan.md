# Greenhouse and Ashby ingestion plan

## Goal

Extend the catalog through reliable, employer-published Greenhouse and Ashby job-board data while preserving the product's direct-to-employer, technical-internship focus. This is an ingestion platform extension, not broad browser scraping and not application automation.

Employer selection stays with the owner. This plan begins once the owner supplies an approved company and its official careers-page URL; it does not require InternNotifs to maintain or purchase a global company directory.

## Plain-language terms

- **Reviewed board list:** InternNotifs' approved list of employer career boards to check.
- **Source reader:** a small provider-specific piece of code that reads public job data and converts it to InternNotifs' common listing format. Code often calls this an *adapter*.
- **Snapshot:** the complete set of roles visible on one board at one point in time.
- **Shadow mode:** checking a source and measuring quality without showing its roles to users.

## Core model

The system maintains a reviewed board list, then applies the same lifecycle to every provider. Greenhouse and Ashby are the first source readers; later providers should follow the same shared rules.

```mermaid
flowchart LR
    R[Reviewed board list] --> F[Source reader]
    F --> V[Validate and normalize]
    V --> S[Shadow observation]
    S -->|approved| P[Production publication]
    S -->|unstable or unsafe| Q[Quarantine and review]
    P --> C[Updated catalog]
    C --> N[User alerts for new matching roles]
```

## Reviewed board list

The reviewed board list defines what the product covers. Each board entry includes the employer, provider, public board identifier, expected application domains, polling policy, review state, and a person responsible for it. It also records operational state such as last successful fetch and current health.

There is no authoritative global directory of every Greenhouse or Ashby board. The product should therefore claim coverage of its approved board list—not an unprovable promise to index every employer globally. Discovery can propose boards, but only reviewed boards reach publication.

### Employer identity is not an API search

Neither provider accepts an employer name as a job-search query. Greenhouse requires a known `board_token`; Ashby requires a known `job_board_name`. Never turn a user-entered company name directly into a URL such as `https://jobs.ashbyhq.com/{company}`: a name is ambiguous and a guessed board can point to the wrong employer or simply fail.

Each owner-supplied employer therefore needs one canonical identity record before it is polled:

```text
employerId: google
displayName: Google
groupId: alphabet
aliases: [Google, Google LLC, Google DeepMind]
provider: greenhouse
boardToken: google
officialCareersUrl: https://careers.google.com
expectedApplicationHosts: [careers.google.com, job-boards.greenhouse.io]
```

The input matcher first normalizes harmless formatting—case, whitespace, punctuation, accents, and corporate suffixes—then performs an exact lookup against stored IDs and aliases. It does not use fuzzy matching or guess a board name. A ticker such as `TSLA` resolves to `tesla` only if `TSLA` is an explicit stored alias. Likewise, `Alphabet` should resolve to the `alphabet` group and then its explicitly listed member board(s), not be silently treated as identical to every Google-branded job publisher.

An unknown or ambiguous employer produces a review-needed result and makes no provider request. The catalog stores the canonical `displayName`; aliases are lookup-only, so one employer does not appear under several spellings.

### How boards enter the list

1. Start with companies already found in InternNotifs' reviewed catalog feeds and employer roster.
2. Visit the employer's own careers page and identify its Greenhouse or Ashby board there. Do not treat LinkedIn, Indeed, a search result, or another aggregator as the source of truth.
3. Confirm the board belongs to that employer, identify the board token/name, and check that its public response identifies the expected employer or career page.
4. Add the board in shadow mode with the official careers-page URL recorded as review evidence. A reviewer promotes it only after the output and application links pass the checks below.

This deliberately grows a verified employer list; it does not crawl every URL that happens to look like an ATS board.

## Reading each provider

Each source reader consumes the provider's public job-board data and produces a complete board snapshot in the shared listing format. It must:

1. Fetch public published postings without employer credentials, browser automation, or application-submission APIs.
2. Validate the provider response before mapping it into titles, locations, descriptions, identifiers, timestamps, compensation when disclosed, and official application URLs.
3. Classify technical internships, co-ops, and apprenticeships; retain source-declared work mode and eligibility requirements only when clearly present.
4. Emit source health and a safe diagnostic result alongside listings, including a response hash or version signal when available.

The shared rules keep polling, quality checks, duplicate handling, notification behavior, and operational monitoring consistent across providers.

### Exact Greenhouse request and mapping

For a reviewed Greenhouse board, fetch this public JSON endpoint:

```text
GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true
```

The `board_token` is the employer's Greenhouse board identifier, verified from its official careers page. The request needs no employer credentials. From each returned job, retain the job `id`, `title`, `location.name`, `updated_at`, `content`, departments/offices, and `absolute_url`. Store the API URL as the source URL and the job ID as the board-specific record ID. Reject prospect/general-interest posts (`internal_job_id` is `null`) and then apply the technical internship/co-op/apprenticeship checks.

`absolute_url` is still validated as a live HTTPS official application destination before publication. Descriptions are converted to plain text before compensation and eligibility rules are evaluated; the original HTML is not needed in the public catalog. The source ID is `greenhouse-{board_token}` and the job `id` is the board-specific record ID. Before enabling a board, call `GET https://boards-api.greenhouse.io/v1/boards/{board_token}` once and require the returned board name to match the reviewed employer identity.

### Exact Ashby request and mapping

For a reviewed Ashby board, fetch this public JSON endpoint:

```text
GET https://api.ashbyhq.com/posting-api/job-board/{job_board_name}?includeCompensation=true
```

The `job_board_name` is the final path component of the employer's Ashby hosted board, such as `https://jobs.ashbyhq.com/{job_board_name}`. It is obtained from the employer's official careers page, not guessed from the company name. During review, require returned `jobUrl` and `applyUrl` values to use the expected Ashby board path or an explicitly approved employer application host.

Only retain jobs where `isListed` is `true`. Map `title`, `location`, `secondaryLocations`, `descriptionPlain`, `department`, `team`, `publishedAt`, `employmentType`, `workplaceType`, `applyUrl`, `jobUrl`, and disclosed compensation. A role must then pass the same technical internship/co-op/apprenticeship and live-link checks as every other source. `applyUrl` is the candidate handoff; `jobUrl` and the API URL provide traceable source history. The source ID is `ashby-{job_board_name}`; the normalized `applyUrl` is the stable board-specific role key when Ashby does not expose a separate posting ID.

These endpoints are public job-board reads only. InternNotifs does not call Greenhouse's application `POST` endpoint or authenticated Ashby employer-management APIs.

Official API references: [Greenhouse Job Board API](https://developers.greenhouse.io/job-board) and [Ashby Job Postings API](https://developers.ashbyhq.com/docs/public-job-posting-api).

### What runs every five minutes

Each approved board gets an independent fetch task. The first deployment can run those tasks in the existing five-minute Lambda poll; the task boundary remains the same when the work later moves to a queue.

1. Load the board's last successful source state: response hash, last row count, last success time, and active role IDs.
2. Build the request only from the stored provider and board identifier. Use a fixed allowlisted API host, encode the identifier as one URL path segment, and reject any configuration that contains a URL, slash, query string, or unknown provider value.
3. Fetch the provider endpoint above with no credentials. Honor an HTTP ETag when a provider returns one; otherwise compare a local SHA-256 hash of the normalized, sorted response.
4. On a successful response, discard non-public/prospect jobs, convert the remaining data into the shared role shape, set the canonical employer name from the identity record, and run the technical-internship filter.
5. For a new application URL or a changed URL, require HTTPS, reject aggregator destinations, require an expected application host or a reviewed exception, then check that the link resolves. Use `HEAD` first and a small ranged `GET` fallback for sites that reject `HEAD`.
6. Commit the complete successful board result and its new source state together. Only then calculate new, changed, missing, and closed roles.

No third-party wrapper or discovery repository supplies production roles. Those tools can help the owner find candidates, but production data always comes directly from the employer's public Greenhouse or Ashby endpoint.

## Admission and publication lifecycle

| State | Purpose | User-visible behavior |
| --- | --- | --- |
| Candidate | A board has been discovered but not vetted | None |
| Shadow | Fetch and measure output without publishing | None |
| Approved | Stable, employer-owned, useful board | Eligible roles enter the catalog |
| Quarantined | Source or data quality is unsafe | Existing roles are protected; new data is withheld |
| Retired | Board is intentionally no longer maintained | Source stops polling after review |

Shadow mode verifies employer ownership, official apply destinations, technical-intern coverage, predictable data, and source health. Promotion should require representative test data and explicit quality rules.

## Updating new, changed, and closed roles

Every successful board response is a current snapshot, rather than merely a list of additions. The update process:

- saves the first successful response as a baseline without notifying users;
- creates newly seen eligible listings and queues notifications only after the baseline;
- updates materially changed listings while preserving their source history, without treating an edit as a new role;
- records a role as missing on its first absence and closes that board's record only after two consecutive successful complete snapshots omit it; and
- closes the catalog role only when no active source still supports it.

An empty result from a previously active board is never treated as a closure signal. It first triggers the quality gate and source-health alert; existing catalog roles remain unchanged until the board produces a trustworthy complete snapshot again.

## Scale and reliability

Start with frequent polling of the approved board list. As it grows, use a planner that creates one task per board; task runners limit requests per provider, retry temporary failures, and pause a board after repeated failures. One broken board or provider must not consume the entire polling window.

The shared reliability plan supplies source freshness, retry and failed-work handling, alerting, and replay. Key measures are active boards, roles per board, freshness, invalid-link rate, duplicate rate, reader failure rate, and time from employer publication to catalog availability.

## Trust boundaries

Publication gates remain the same for every provider: technical early-career relevance, direct HTTPS application destination, live-link validation, duplicate handling, source history, and checks for bad or unexpectedly changed data. Keep only the evidence needed to debug public job data; never collect applicant data or use credentials intended for employer administration.

## Rollout

1. Define the reviewed-board list and Greenhouse/Ashby source-reader rules with representative test data.
2. Add a small reviewed cohort in shadow mode and validate catalog quality and operational health.
3. Promote stable boards, add role updates/closures, and connect alerts.
4. Scale coverage through the review queue and independent queue-based tasks.

Success means a growing, auditable set of official employer boards that updates quickly, degrades safely, and never creates duplicate, stale, or untrusted catalog entries.
