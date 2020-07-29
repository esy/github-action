# [Esy](esy.sh) GitHub Action

This action runs cached `esy install` and `esy build` in the current directory

## Inputs

### `cache-key`

**Required** The cache key. Typically `${{ hashFiles('**/index.json') }}`

### `esy-prefix`

The prefix of esy folder

### `working-directory`

Working directory.

## Example usage

```
- uses: actions/setup-node@v1.4.2
  with:
    node-version: 12
- name: Install esy
  run: npm install -g esy
- uses: wokalski/esy-github-action@v1
  with:
  cache-key: ${{ hashFiles('**/index.json') }}
```
