# Local proxy TLS test material

These files are deliberately public test credentials for localhost only. Never use this private key or trust this certificate in a deployment. The tests add the certificate only to their isolated worker process and restore the previous CA list afterward; no machine or Codex configuration is changed.

The self-signed certificate has DNS SAN localhost (no IP SAN), allowing positive Host/SNI checks and negative hostname checks. The suite also removes its process-local trust to prove chain validation remains enabled. Generated with OpenSSL for ten years of test validity; replace both files before expiry.
