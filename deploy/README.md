# deploy

| Path                                 | Purpose                                     | Build-order step |
| ------------------------------------ | ------------------------------------------- | ---------------- |
| `docker-compose.yml`                 | Local Postgres 16, Redis, MinIO             | 2                |
| `auth0/`                             | Auth0 tenant setup guide, post-login Action | 9                |
| `helm/speaksplit/`                   | Helm chart for API, worker, migrations Job  | 10               |
| `argocd/`                            | Argo CD Applications                        | 11               |
| `terraform/local/`, `terraform/aws/` | OpenTofu/Terraform per target (k3s VM, EKS) | 11               |
