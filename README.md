# Greens Internal Website

This workspace contains a static site in `src/scratch/master-construction-portal`.

## Deploying to GitHub Pages

This repository includes a GitHub Actions workflow at `.github/workflows/deploy.yml` which will publish the `src/scratch/master-construction-portal` folder to the `gh-pages` branch when you push to `main`.

Steps to publish:

1. Create a GitHub repository (via the web UI or `gh repo create`).
2. From this repo root run:

```powershell
git init
git add .
git commit -m "Initial commit: add site and deployment workflow"
git branch -M main
git remote add origin git@github.com:<your-username>/<your-repo>.git
git push -u origin main
```

3. After the push, the Actions workflow will run and deploy the site to the `gh-pages` branch. Pages will become available at `https://<your-username>.github.io/<your-repo>/` once GitHub finishes publishing.
