# CEX-701 Device Recovery Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task.

**Goal:** Complete existing identity recovery in Web Settings and provide actionable Android recovery without new registry or privilege escalation.
**Architecture:** Canonical enrollment API remains authority. Owner explicitly selects known logical device and confirms owner_approved_reinstall proof; session can inspect/revoke only itself and receives owner-Web guidance. Clone findings render typed warnings, never auto-delete.
**Tech stack:** Vanilla JS Web, Kotlin Compose Android, existing Gateway identity lifecycle.
**Authority:** Owner delegates unspecified choices to optimal engineering judgement; native inline execution without repeating design approval. Digital claim7aea18f; immutable baseline40e18db4a6cf5bba1490181a473bc62e681edb8a.

- [x] Task1: Write failing browser/API tests for UNBOUND recovery, clone warning, explicit selection/proof, wrong proof, member absence of owner actions, self/other revoke. Add Web recovery render module and rebind client request. Preserve input/focus during refresh and reconcile canonical states. Commit with red/green receipts.
- [x] Task2: Write failing Android policy tests for unbound/refused recovery and safe credential-free owner link. Add Settings identity panel via existing CityClient async API, clone warnings, recovery guidance and explicit Find City action; owner rebind routed to existing Web control. Build/unit tests and physical-device validation where connected. Commit evidence.
- [ ] Task3: Browser negatives/authority regression, bilingual docs, focused and full required CI. Record failures/decisions in bounded Digital paper index; raw logs remain ignored Utopia runtime, selected receipts under evidence/raw. Prepare opposite-physical-host review packet and mark development only after exact HEAD verified. Never mark formal review locally.

**Exposure:** DIRECT_CONTROL recovery in contextual Settings L2; clone/security states BACKGROUND_DISCLOSED in Settings; full IDs folded technical detail L4. Existing privileges and API errors visibly preserved. Android guides to connected owner Web if native proof flow unavailable. No credential in shared URL.
