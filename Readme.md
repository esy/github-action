# [Esy](esy.sh) GitHub Action

This action runs cached `esy install` and `esy build` in the current directory

## Inputs

### `cache-key`

**Required** The cache key. Typically `${{ hashFiles('**/index.json') }}`

### `esy-prefix`

The prefix of esy folder

## Example usage

```
uses: wokalski/esy-github-action@v1
with:
  cache-key: ${{ hashFiles('**/index.json') }}
```
