"""One teaching completion path for uploads, repairs and existing-video refresh."""
from teaching_coverage import complete_coverage
from teaching_details import complete_details


def complete_teaching(rows, config=None, progress=None, cache_dir=None):
    reviewed, selection_requests = complete_coverage(rows, config, progress, cache_dir)
    completed, detail_requests = complete_details(reviewed, config, progress, cache_dir)
    return completed, selection_requests + detail_requests
