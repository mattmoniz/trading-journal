"""Hard no-order boundary for the marks shadow system (docs/MARKS_BUILD_FRAMEWORK_20261029.md principle 4). Shadow rows go to amt_marks_shadow only; nothing in this package may import an order, DTC or active_setups writer."""
ORDERS_ENABLED = False

def assert_no_orders():
    if ORDERS_ENABLED: raise RuntimeError('marks shadow system must not place orders (ORDERS_ENABLED must stay False until the user changes it after the sealed look and a forward shadow period)')
