# Changelog

## [0.2.1](https://github.com/srobroek/omp-orchestrate/compare/v0.2.0...v0.2.1) (2026-08-26)


### Bug Fixes

* **beads:** track config.yaml so a clone has issue-prefix ([#33](https://github.com/srobroek/omp-orchestrate/issues/33)) ([4bc55fd](https://github.com/srobroek/omp-orchestrate/commit/4bc55fdb74022d38999dca6566e1c359ba39d518))
* **release:** let the release PR branch carry the component, so the tag cuts itself ([#38](https://github.com/srobroek/omp-orchestrate/issues/38)) ([79fc90d](https://github.com/srobroek/omp-orchestrate/commit/79fc90d7a42c492fc33b3ef5801297cd41eb41e3))
* **shell:** only treat command-slot bd as an invocation ([#37](https://github.com/srobroek/omp-orchestrate/issues/37)) ([b091ea3](https://github.com/srobroek/omp-orchestrate/commit/b091ea304a5ae5aca50184a1245fa27dfbd5bb2d))
* write load-oracle marker after factory registrations ([#40](https://github.com/srobroek/omp-orchestrate/issues/40)) ([969fe30](https://github.com/srobroek/omp-orchestrate/commit/969fe30893088cce08ebbd1cfedd92dbd5bb96d7))

## [0.2.0](https://github.com/srobroek/omp-orchestrate/compare/v0.1.4...v0.2.0) (2026-08-26)


### ⚠ BREAKING CHANGES

* **beads:** go back to embedded, and pin one path instead of running a server ([#27](https://github.com/srobroek/omp-orchestrate/issues/27))

### Features

* **beads:** the run owns the dolt server, and a slow bd stops blocking every call ([#26](https://github.com/srobroek/omp-orchestrate/issues/26)) ([6d33880](https://github.com/srobroek/omp-orchestrate/commit/6d33880ae9b8d4729102aa34d814e163fb668103))
* **marketplace:** publish a catalog so this repo installs from its own remote ([#29](https://github.com/srobroek/omp-orchestrate/issues/29)) ([c8aee4c](https://github.com/srobroek/omp-orchestrate/commit/c8aee4c2cb71fdb3f46990ac8ecef0350d5fc502))


### Bug Fixes

* **docs:** stop the README owning a version nothing bumps ([#30](https://github.com/srobroek/omp-orchestrate/issues/30)) ([a1e585e](https://github.com/srobroek/omp-orchestrate/commit/a1e585e71b821a77215dd43122c3fae9b235b3a8))


### Code Refactoring

* **beads:** go back to embedded, and pin one path instead of running a server ([#27](https://github.com/srobroek/omp-orchestrate/issues/27)) ([60fb879](https://github.com/srobroek/omp-orchestrate/commit/60fb87986dd0a2f8f34e9ac114731bb653760ee0))

## [0.1.4](https://github.com/srobroek/omp-orchestrate/compare/v0.1.3...v0.1.4) (2026-08-26)


### Bug Fixes

* **beads:** drop the worktree guard, because bd already resolves the primary ([#25](https://github.com/srobroek/omp-orchestrate/issues/25)) ([a8bbbfe](https://github.com/srobroek/omp-orchestrate/commit/a8bbbfec80e8834985e2e959d27fe04846850d1a))

## [0.1.3](https://github.com/srobroek/omp-orchestrate/compare/v0.1.2...v0.1.3) (2026-08-26)


### Bug Fixes

* **beads:** stop a worktree minting its own empty database, and sync the database ([#23](https://github.com/srobroek/omp-orchestrate/issues/23)) ([4918b88](https://github.com/srobroek/omp-orchestrate/commit/4918b88f6cfa92bf3e983ca2a1b03d503ed2a63e))
* **release:** put the version in the release PR title so the tag can be cut ([#21](https://github.com/srobroek/omp-orchestrate/issues/21)) ([13c6b66](https://github.com/srobroek/omp-orchestrate/commit/13c6b665516a3d8d2e6bfa436b8d51878a3d8d96))

## [0.1.2](https://github.com/srobroek/omp-orchestrate/compare/v0.1.1...v0.1.2) (2026-08-26)


### Features

* **contract:** pin every worker's bd calls at the run repository ([fc0db83](https://github.com/srobroek/omp-orchestrate/commit/fc0db833cdf467eb4d6c6126b636314067714f6a))
* **orchestrate:** route the incidental bug a worker runs into ([f997815](https://github.com/srobroek/omp-orchestrate/commit/f99781551ed6f5bdf04a340afc3f62c760b18268))
* **orchestrate:** route the incidental bug a worker runs into ([40d5300](https://github.com/srobroek/omp-orchestrate/commit/40d5300096658f88cd3155e3ab3af2fd9b92ea4f))
* role routing on metadata, parser-backed bd gates, ensured prerequisites ([#14](https://github.com/srobroek/omp-orchestrate/issues/14)) ([c681218](https://github.com/srobroek/omp-orchestrate/commit/c6812183f721aec42f22c211ed093bb2455ff84f))
* **rules:** remind an agent when a bd call is not pinned to the run ([c291246](https://github.com/srobroek/omp-orchestrate/commit/c2912466c17614d0a8a001651b194ee216e59a38))
* **run:** require a server-mode beads database to activate a run ([#17](https://github.com/srobroek/omp-orchestrate/issues/17)) ([2723713](https://github.com/srobroek/omp-orchestrate/commit/2723713d81b34ac887f2878f02883bc2f8c670be))


### Bug Fixes

* **agents:** restore the designer grant the prose already promised ([#18](https://github.com/srobroek/omp-orchestrate/issues/18)) ([5f8205f](https://github.com/srobroek/omp-orchestrate/commit/5f8205fe03aa8ed2eb81fcab93f9bb24550c1255))
* close a claim-gate denial of service and six authority bypasses ([2f02e93](https://github.com/srobroek/omp-orchestrate/commit/2f02e93fa4141822a11c5b2f7286566974e62dcb))
* close a claim-gate denial of service and six authority bypasses ([cab9ba5](https://github.com/srobroek/omp-orchestrate/commit/cab9ba5a2937c69e50137ffdff42e0d0b2e845d3))
* **gates:** record the claim from its report, not from the command ([#20](https://github.com/srobroek/omp-orchestrate/issues/20)) ([7e47038](https://github.com/srobroek/omp-orchestrate/commit/7e4703826c3a88da3bf1a6c64c98c013702bf9a3))
* **gates:** replace the bd actor-prefix rule with a tokeniser gate ([a5b686e](https://github.com/srobroek/omp-orchestrate/commit/a5b686e8225078f6efcd48978fafb04e42e970ad))
* **gates:** replace the comment-verb rule with a tokeniser gate ([7f4c038](https://github.com/srobroek/omp-orchestrate/commit/7f4c038776083fc6f574ded7854e303e6d0a1b72))
* **gates:** replace the one-claim rule with a tokeniser gate ([e1767fa](https://github.com/srobroek/omp-orchestrate/commit/e1767fa1ace72e8e5a511ea1790c7c18dca480a8))
* **gates:** supply the bd pin instead of refusing an unpinned call ([0410cf4](https://github.com/srobroek/omp-orchestrate/commit/0410cf4724e3583d48c90ab4394d859b2d711359))
* parse bd commands instead of matching text, and supply the pin ([adf295f](https://github.com/srobroek/omp-orchestrate/commit/adf295fc2717561dcf4b45ad259d103cf0d7e83f))
* **run-state:** reset the read budget before arming the patrol ([0ec4e76](https://github.com/srobroek/omp-orchestrate/commit/0ec4e76e5a5014be404ae5840a02b02146014856))
* **watchers:** do not warn about beads in a repository that has none ([8471ca8](https://github.com/srobroek/omp-orchestrate/commit/8471ca8408187023aef2f8a7e1f19e39670bcd90))
* **watchers:** read both carriers bd uses for server mode ([c1c3fa5](https://github.com/srobroek/omp-orchestrate/commit/c1c3fa594e7ef1d1ca0ec10476c173671261688d))

## [0.1.1](https://github.com/srobroek/omp-orchestrate/compare/v0.1.0...v0.1.1) (2026-08-25)


### Features

* beads-backed multi-agent orchestration for OMP ([b27ab47](https://github.com/srobroek/omp-orchestrate/commit/b27ab47f54d0a56185e30064a1388b1c8af3b427))


### Bug Fixes

* hardening from end-to-end and adversarial verification ([83f4011](https://github.com/srobroek/omp-orchestrate/commit/83f4011333249e8bce909aa92723fc7fa481b07c))
* **watchers:** treat an unreadable isolation mode as unknown ([67a4af1](https://github.com/srobroek/omp-orchestrate/commit/67a4af18f0d2a3dcc81ea2b855470c8756686040))
