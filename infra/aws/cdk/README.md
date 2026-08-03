# AWS CDK Fallback Infrastructure Comparison Template

This directory contains reference infrastructure code for AWS (S3 + CloudFront + OAC) for comparison with Cloudflare.

## Architecture

* **Storage**: Amazon S3 (`PrivateBucket`)
* **Distribution**: Amazon CloudFront
* **Access Control**: Origin Access Control (OAC)
* **Custom Domain**: AWS Route 53 + ACM Certificate

## Evaluation Result

As documented in [ADR 0002](../../docs/adr/0002-cloud-infrastructure-selection.md), **Cloudflare R2** was selected as the primary distribution infrastructure due to **$0 egress fees** for large H3 tile distribution.
