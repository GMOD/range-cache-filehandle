## [1.5.2](https://github.com/GMOD/range-cache-filehandle/compare/v1.5.1...v1.5.2) (2026-10-14)

### Other Changes

- Rewrite AI-writing tropes in README and docs ([e13162c](https://github.com/GMOD/range-cache-filehandle/commit/e13162cf71e45072e2873f35a670f0c6ee6b590b))
- Restore claims changed by the tropes rewrite ([c462dcd](https://github.com/GMOD/range-cache-filehandle/commit/c462dcd669395f39ceabb06d637fd0e28a1c374a))
- Fold short verdict sentences into their neighbours ([5ef833c](https://github.com/GMOD/range-cache-filehandle/commit/5ef833cb5b16e24304615192ab1cb7e477b089fb))
- Fix doc errors found in the tropes audit ([15d006f](https://github.com/GMOD/range-cache-filehandle/commit/15d006fd9e40858282c7d3ef734779b6990f05e0))
- Restore wording the tropes rewrite changed without a trope ([aa94365](https://github.com/GMOD/range-cache-filehandle/commit/aa94365a245e3d5c4bdc3b2aab7434f36b96e983))
- Fix the Pool comment: the pool is per origin, not per key ([e327344](https://github.com/GMOD/range-cache-filehandle/commit/e327344e857276b5853fc55bdd0040520d6665a3))
- Say per origin in the remaining pool comments ([e6b23b6](https://github.com/GMOD/range-cache-filehandle/commit/e6b23b6a46cd2ce9d343f51aac13992c7d0c24fa))
- Trim wordiness in README and docs ([978072b](https://github.com/GMOD/range-cache-filehandle/commit/978072b28691ef3a188f22bffdf4f91853883618))
- Keep a clear from being undone by the size a request in flight learns ([75bacde](https://github.com/GMOD/range-cache-filehandle/commit/75bacde31253fd1d683e2945af71f437d593f06b))
- Fail a 416 whose own Content-Range puts the range inside the file ([1e533f4](https://github.com/GMOD/range-cache-filehandle/commit/1e533f4880d5eb03109c91154d6375685ce28548))
- Recognize a network TypeError from another realm ([f5e06f3](https://github.com/GMOD/range-cache-filehandle/commit/f5e06f3cbd7f954eade57660b0512fa21a1d07a4))
- Pass the chunk cache a signal instead of a RequestInit ([1066419](https://github.com/GMOD/range-cache-filehandle/commit/106641944b922d0a7442f5d6e5563a658ed9fc84))
- Fold putSize into recordSize ([f1be7b1](https://github.com/GMOD/range-cache-filehandle/commit/f1be7b179a59cc9fd0303602ecbce1e4e3088c90))
- Read an unchecked 206 body only as far as the request ([c0f0044](https://github.com/GMOD/range-cache-filehandle/commit/c0f0044d894ec3c09c470c406d7e837e6433a0e3))
- Say what CachedFilehandle loses around a RemoteFile ([f88dc3a](https://github.com/GMOD/range-cache-filehandle/commit/f88dc3a2e31a5c1f52104b70057c196c87484f7e))
- Compare large byte arrays with expectBytes in every test ([8b1d5b1](https://github.com/GMOD/range-cache-filehandle/commit/8b1d5b1d322b4b0221caef57a5c9626e227f32fb))
- Flood the eviction test with small bodies ([b1b73e8](https://github.com/GMOD/range-cache-filehandle/commit/b1b73e8b643be53ec2d4c85b8a5f7d37cc12a562))

## [1.5.1](https://github.com/GMOD/range-cache-filehandle/compare/v1.5.0...v1.5.1) (2026-10-11)

### Documentation

- Plainer README wording ([718c078](https://github.com/GMOD/range-cache-filehandle/commit/718c078e9e233db62650ef08cab353ac21b8e0c7))
- Break up README walls of text ([16fe0e8](https://github.com/GMOD/range-cache-filehandle/commit/16fe0e8c8c767b7cc65d86b9d25cddc0e61963a9))

### Tests

- Fail when docs/api.md misses a public member or export ([9da615d](https://github.com/GMOD/range-cache-filehandle/commit/9da615dcb4803455b766e671d78bdfac9a5641d4))

## [1.5.0](https://github.com/GMOD/range-cache-filehandle/compare/v1.4.0...v1.5.0) (2026-10-01)

### Bug Fixes

- Release an aborted reader at once, with its own reason ([642a1ee](https://github.com/GMOD/range-cache-filehandle/commit/642a1eed4964b31e6911b9becab41281dbe5b7bb))
- ClearCache leaves the concurrency pools alone ([b2ff987](https://github.com/GMOD/range-cache-filehandle/commit/b2ff9879dd144b28b2334a8e007f4e60cb1d6812))
- A rewritten local file gets a fresh cache identity ([f7be375](https://github.com/GMOD/range-cache-filehandle/commit/f7be3753df01d2f5aa5000c4e8c43d3e4c57e9e5))
- Build every request through RemoteFile.buildRequest ([c3f5935](https://github.com/GMOD/range-cache-filehandle/commit/c3f5935d06c5a2b6e39fb147f8d5892f44945f72))
- Compose the response deadline with AbortSignal.any ([613b415](https://github.com/GMOD/range-cache-filehandle/commit/613b415f430a0539a834c2e4c569243ecaf638ff))
- Re-arm the response deadline while the browser queues the request ([b24aaca](https://github.com/GMOD/range-cache-filehandle/commit/b24aacadfd6816d8578c8bfd9067c18eebb94041))
- CachedFilehandle no longer stats before its first read ([67ad5a2](https://github.com/GMOD/range-cache-filehandle/commit/67ad5a23d5101596f37a26d844aa450ab7bd83ec))

### Documentation

- Add optimizations.md ([485eee2](https://github.com/GMOD/range-cache-filehandle/commit/485eee2015a85464d9d6b166b623b4cdb98ae734))
- Fix anti-AI prose tropes (dramatic negation, "So"/"That" openings, changelog framing) ([d9751e0](https://github.com/GMOD/range-cache-filehandle/commit/d9751e056a31218a43008899e629f990b0510492))
- Fix inanimate-subject agency and figures of speech, and restore a dropped detail ([9250194](https://github.com/GMOD/range-cache-filehandle/commit/92501940549d1ad9127d8344aab5895c68b13b13))
- Name the contig-orientation rule and the cache's coverage exactly ([b04893b](https://github.com/GMOD/range-cache-filehandle/commit/b04893b4e90fbbbb442a1e7761c5722cef96e388))

### Other Changes

- Depend on generic-filehandle2 ^2.5.0 ([3f34895](https://github.com/GMOD/range-cache-filehandle/commit/3f3489551a765a3302d3626d9e812979095e5765))
- Update pnpm-lock.yaml for generic-filehandle2 ^2.5.0 ([fbbf700](https://github.com/GMOD/range-cache-filehandle/commit/fbbf70042deec9ba4f6bdef72c15faa1bf222d6f))

## [1.4.0](https://github.com/GMOD/range-cache-filehandle/compare/v1.3.0...v1.4.0) (2026-08-23)

### Bug Fixes

- Put the response deadline on whole-file reads too ([ea510fe](https://github.com/GMOD/range-cache-filehandle/commit/ea510feb6c600e7761bcf8e25aa1c3f1a24ee237))

## [1.3.0](https://github.com/GMOD/range-cache-filehandle/compare/v1.2.0...v1.3.0) (2026-08-23)

### Bug Fixes

- Refuse a 200 that declares more bytes than the range asked for ([7127aa9](https://github.com/GMOD/range-cache-filehandle/commit/7127aa93dc39aa645989a6f4e26f9d2f66f8c652))
- Bound body reads instead of trusting Content-Length for size ([cc08eb2](https://github.com/GMOD/range-cache-filehandle/commit/cc08eb25ea90574a5111f7ca5f46050053c0bb53))

### Documentation

- Generate the architecture and chunk diagrams from the source ([a2015a3](https://github.com/GMOD/range-cache-filehandle/commit/a2015a3f7d34eed2f297133c371fcfdf9d28e7a6))

### Features

- A cached handle says where its bytes come from ([f9cf573](https://github.com/GMOD/range-cache-filehandle/commit/f9cf57367f108409d8a4ca344fc5b52667adfb20))

## [1.2.0](https://github.com/GMOD/range-cache-filehandle/compare/v1.1.0...v1.2.0) (2026-08-17)

### Bug Fixes

- Carry the constructor's headers, overrides and signal into a read ([3863992](https://github.com/GMOD/range-cache-filehandle/commit/386399211ac9f2fb7069a7f6cad647347310de52))
- Reject a Content-Range that contradicts itself, however the body is encoded ([f81558f](https://github.com/GMOD/range-cache-filehandle/commit/f81558fd81dde5890bf07b3d4a0d73d3f7e180d7))
- Let an abort reach a read waiting for a concurrency slot ([eaf3fe4](https://github.com/GMOD/range-cache-filehandle/commit/eaf3fe46734d8b023ae3d4bd01f07a7a27492063))
- Guard the range a fetch() Range header asks for ([74b7ba8](https://github.com/GMOD/range-cache-filehandle/commit/74b7ba8e7a1a2a6d0c4473203acd47303d63bf2c))
- Forward a read's options through CachedFilehandle ([39c4e8a](https://github.com/GMOD/range-cache-filehandle/commit/39c4e8ad2bc77a7c3a585ce623dfb2b834001d1a))
- Hand a short read its own buffer rather than a view of a longer one ([abecf60](https://github.com/GMOD/range-cache-filehandle/commit/abecf60bb821564c421cd1418d53f0a13f69cc43))

### Documentation

- What the URL key does not separate, and what a Content-Encoding hides ([f1a2d13](https://github.com/GMOD/range-cache-filehandle/commit/f1a2d1325b6739150ee112996b0b4b1841588695))

## [1.1.0](https://github.com/GMOD/range-cache-filehandle/compare/v1.0.2...v1.1.0) (2026-08-17)

### Bug Fixes

- Validate range responses, scope concurrency per file, guard read args ([e5cff83](https://github.com/GMOD/range-cache-filehandle/commit/e5cff834af879ec342937c580de5e20e34c9b2ea))
- Check a 206 against the request, not only against itself ([e6cc003](https://github.com/GMOD/range-cache-filehandle/commit/e6cc003440e7c50dcb82c5845ccf0e828b809573))

### Documentation

- Npm version and CI badges ([adeb3c1](https://github.com/GMOD/range-cache-filehandle/commit/adeb3c135e21d115cac263555977594dea1ab4a1))
- Dataflow diagram, request sharing, tuning and errors ([bd2f2f3](https://github.com/GMOD/range-cache-filehandle/commit/bd2f2f33c431f8c79d907c0327984c6a65e38ed7))
- Api reference, and what changes outside a browser ([8b75915](https://github.com/GMOD/range-cache-filehandle/commit/8b75915dd8ecdb8e6f9393d9b3c38dd0c0702b90))

## [1.0.2](https://github.com/GMOD/range-cache-filehandle/compare/...v1.0.2) (2026-08-16)

### Chores

- Record the 1.0.0 and 1.0.1 setup publishes ([32643ea](https://github.com/GMOD/range-cache-filehandle/commit/32643eaed93578695e7830c4377311c28da9faef))

### Documentation

- README, and credit http-range-fetcher which this replaces ([9d17425](https://github.com/GMOD/range-cache-filehandle/commit/9d17425915a34ab0e3159cdf6467b4498cd6fa34))

### Features

- Extract RemoteFileWithRangeCache from jbrowse-components ([edb29cd](https://github.com/GMOD/range-cache-filehandle/commit/edb29cd5fef0e1cce21832887c10792d66d7c001))

