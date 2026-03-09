Hanabi benchmark reference outputs
=================================

These files are authoritative byte-for-byte output snapshots used by:

  benchmarks/hanabi/verify_outputs.sh

Current references:
- binarytrees/10_out
- nbody/1000_out
- fasta/1000_out

Provenance:
- Generated from the in-repo C reference implementations under benchmarks/hanabi/.
- Intended to match the hanabi benchmark expected-output conventions.

Regeneration (from repository root):

  mkdir -p benchmarks/hanabi/references/{binarytrees,nbody,fasta}
  cc -O3 benchmarks/hanabi/binary-trees/binary_trees.c -o /tmp/hanabi-binarytrees-ref
  /tmp/hanabi-binarytrees-ref 10 > benchmarks/hanabi/references/binarytrees/10_out
  cc -O3 benchmarks/hanabi/nbody/nbody.c -lm -o /tmp/hanabi-nbody-ref
  /tmp/hanabi-nbody-ref 1000 > benchmarks/hanabi/references/nbody/1000_out
  cc -O3 benchmarks/hanabi/fasta/fasta.c -o /tmp/hanabi-fasta-ref
  /tmp/hanabi-fasta-ref 1000 > benchmarks/hanabi/references/fasta/1000_out

