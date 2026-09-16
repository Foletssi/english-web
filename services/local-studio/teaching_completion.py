"""One teaching completion path for uploads, repairs and existing-video refresh."""
from teaching_coverage import complete_coverage
from teaching_details import complete_details
from teaching_eligibility import refine_eligibility


def complete_teaching(rows, config=None, progress=None, cache_dir=None):
    reviewed, selection_requests = complete_coverage(rows, config, progress, cache_dir)
    reviewed, eligibility_requests = refine_eligibility(reviewed, config, progress, cache_dir)
    completed, detail_requests = complete_details(reviewed, config, progress, cache_dir)
    return completed, selection_requests + eligibility_requests + detail_requests
