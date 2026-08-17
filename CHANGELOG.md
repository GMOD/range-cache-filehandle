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

