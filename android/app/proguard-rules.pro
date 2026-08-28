# Empty on purpose. Nothing in the app reflects over its own types yet, and kotlinx
# serialization's own consumer rules ship with the artifact.
#
# When a rule IS needed, record what broke without it -- a ProGuard file whose entries have
# no reason attached becomes permanently un-prunable, because nobody can tell which lines
# are still load-bearing.
