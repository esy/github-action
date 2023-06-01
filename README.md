# esy - GitHub Action

This action runs cached `esy install` and `esy build` in the current directory

## Inputs

- `cache-key`: **Required** The cache key. Typically
  `${{ hashFiles('esy.lock/index.json') }}`
- `esy-prefix`: The prefix of esy folder
- `working-directory`: Working directory.
- `manifest`: JSON or opam file to be used

## Example usage

```yml
- uses: actions/setup-node@v2
  with:
    node-version: 16
- name: Install esy
  run: npm install -g esy
- uses: esy/github-action@v1
  with:
    cache-key: ${{ hashFiles('esy.lock/index.json') }}
```
