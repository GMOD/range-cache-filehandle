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

