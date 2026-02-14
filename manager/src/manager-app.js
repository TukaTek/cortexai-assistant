// Client-side JS for Fleet Manager dashboard.
// No fancy syntax: keep it maximally compatible (same pattern as setup-app.js).
// Two views: tenant list (default) and instance list (within a tenant).

(function () {
  // --- DOM refs ---
  var tenantsListEl = document.getElementById('tenantsList');
  var instancesListEl = document.getElementById('instancesList');
  var breadcrumbSepEl = document.getElementById('breadcrumbSep');
  var breadcrumbTenantEl = document.getElementById('breadcrumbTenant');
  var showCreateEl = document.getElementById('showCreate');
  var refreshAllEl = document.getElementById('refreshAll');

  // Tenant create form
  var createTenantPanelEl = document.getElementById('createTenantPanel');
  var createTenantNameEl = document.getElementById('createTenantName');
  var createTenantNotesEl = document.getElementById('createTenantNotes');
  var createTenantRunEl = document.getElementById('createTenantRun');
  var createTenantCancelEl = document.getElementById('createTenantCancel');

  // Instance create form
  var createPanelEl = document.getElementById('createPanel');
  var createNameEl = document.getElementById('createName');
  var createPasswordEl = document.getElementById('createPassword');
  var createNotesEl = document.getElementById('createNotes');
  var createRunEl = document.getElementById('createRun');
  var createCancelEl = document.getElementById('createCancel');
  var createLogEl = document.getElementById('createLog');

  // --- State ---
  var currentView = 'tenants'; // 'tenants' or 'instances'
  var currentTenantId = null;
  var currentTenantName = null;

  // --- Helpers ---

  function httpJson(url, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    return fetch(url, opts).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error('HTTP ' + res.status + ': ' + (t || res.statusText));
        });
      }
      return res.json();
    });
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.appendChild(document.createTextNode(String(s || '')));
    return d.innerHTML;
  }

  function statusLabel(status) {
    var labels = {
      'running': 'Running',
      'needs-setup': 'Needs Setup',
      'building': 'Building',
      'deploying': 'Deploying',
      'failed': 'Failed',
      'unhealthy': 'Unhealthy',
      'stopped': 'Stopped',
      'no-deployment': 'No Deployment',
      'unknown': 'Unknown'
    };
    return labels[status] || status;
  }

  function statusDotClass(status) {
    var map = {
      'running': 'status-running',
      'needs-setup': 'status-needs-setup',
      'building': 'status-building',
      'deploying': 'status-deploying',
      'failed': 'status-failed',
      'unhealthy': 'status-unhealthy',
      'stopped': 'status-stopped',
      'no-deployment': 'status-no-deployment',
      'unknown': 'status-unknown'
    };
    return map[status] || 'status-unknown';
  }

  // --- Navigation ---

  function showTenantsView() {
    currentView = 'tenants';
    currentTenantId = null;
    currentTenantName = null;

    tenantsListEl.style.display = '';
    instancesListEl.style.display = 'none';
    createPanelEl.style.display = 'none';
    createTenantPanelEl.style.display = 'none';

    breadcrumbSepEl.style.display = 'none';
    breadcrumbTenantEl.style.display = 'none';

    showCreateEl.textContent = 'New Tenant';
    showCreateEl.onclick = showCreateTenant;

    loadTenants();
  }

  function showInstancesView(tenantId, tenantName) {
    currentView = 'instances';
    currentTenantId = tenantId;
    currentTenantName = tenantName;

    tenantsListEl.style.display = 'none';
    instancesListEl.style.display = '';
    createPanelEl.style.display = 'none';
    createTenantPanelEl.style.display = 'none';

    breadcrumbSepEl.style.display = '';
    breadcrumbTenantEl.style.display = '';
    breadcrumbTenantEl.textContent = tenantName;

    showCreateEl.textContent = 'New Instance';
    showCreateEl.onclick = showCreateInstance;

    loadInstances(tenantId);
  }

  // --- Tenant list ---

  function loadTenants() {
    tenantsListEl.innerHTML = '<p class="muted">Loading tenants...</p>';

    httpJson('/api/tenants').then(function (j) {
      var tenants = j.tenants || [];

      if (tenants.length === 0) {
        tenantsListEl.innerHTML = '<div class="card"><p class="muted">No tenants yet. Click "New Tenant" to create one.</p></div>';
        return;
      }

      var html = '<div class="tenant-grid">';
      for (var i = 0; i < tenants.length; i++) {
        var t = tenants[i];
        html += '<div class="tenant-card" onclick="fleetActions.openTenant(\'' + escapeHtml(t.id) + '\', \'' + escapeHtml(t.name) + '\')">';
        html += '<h3>' + escapeHtml(t.name) + '</h3>';
        html += '<div class="muted"><span class="instance-count">' + t.instanceCount + '</span> instance' + (t.instanceCount !== 1 ? 's' : '') + '</div>';
        if (t.notes) {
          html += '<div class="muted" style="margin-top:0.25rem">' + escapeHtml(t.notes) + '</div>';
        }
        html += '<div class="muted" style="margin-top:0.25rem">Created: ' + escapeHtml(t.createdAt ? new Date(t.createdAt).toLocaleDateString() : '?') + '</div>';
        html += '<div class="instance-actions">';
        html += '<button class="btn-danger" onclick="event.stopPropagation(); fleetActions.removeTenant(\'' + escapeHtml(t.id) + '\', \'' + escapeHtml(t.name) + '\', ' + t.instanceCount + ')">Delete</button>';
        html += '</div>';
        html += '</div>';
      }
      html += '</div>';

      tenantsListEl.innerHTML = html;
    }).catch(function (e) {
      tenantsListEl.innerHTML = '<div class="card"><p style="color:#f87171">Error loading tenants: ' + escapeHtml(String(e)) + '</p></div>';
    });
  }

  // --- Instance list ---

  function loadInstances(tenantId) {
    instancesListEl.innerHTML = '<p class="muted">Loading instances...</p>';

    httpJson('/api/tenants/' + tenantId + '/instances').then(function (j) {
      var instances = j.instances || [];

      if (instances.length === 0) {
        instancesListEl.innerHTML = '<div class="card"><p class="muted">No instances yet. Click "New Instance" to create one.</p></div>';
        return;
      }

      var html = '<div class="instance-grid">';
      for (var i = 0; i < instances.length; i++) {
        var inst = instances[i];
        var dotClass = statusDotClass(inst.status);
        var label = statusLabel(inst.status);
        var domainLink = inst.domain
          ? '<a href="https://' + escapeHtml(inst.domain) + '/setup" target="_blank" style="color:#FF6B35; text-decoration:none;">' + escapeHtml(inst.domain) + '</a>'
          : '<span class="muted">Pending...</span>';

        html += '<div class="instance-card">';
        html += '<h3>' + escapeHtml(inst.name) + '</h3>';
        html += '<div><span class="status-dot ' + dotClass + '"></span> ' + escapeHtml(label) + '</div>';
        html += '<div class="muted" style="margin-top:0.25rem">Domain: ' + domainLink + '</div>';
        if (inst.setupPassword) {
          html += '<div class="muted" style="margin-top:0.25rem">Setup password: <code>' + escapeHtml(inst.setupPassword) + '</code></div>';
        }
        if (inst.tailscale && inst.tailscale.hostname) {
          html += '<div class="muted" style="margin-top:0.25rem">Tailscale: <a href="https://' + escapeHtml(inst.tailscale.hostname) + '/" target="_blank" style="color:#4ade80; text-decoration:none;">' + escapeHtml(inst.tailscale.hostname) + '</a></div>';
        }
        if (inst.notes) {
          html += '<div class="muted" style="margin-top:0.25rem">' + escapeHtml(inst.notes) + '</div>';
        }
        html += '<div class="muted" style="margin-top:0.25rem">Created: ' + escapeHtml(inst.createdAt ? new Date(inst.createdAt).toLocaleDateString() : '?') + '</div>';

        html += '<div class="instance-actions">';
        if (inst.domain) {
          html += '<a href="https://' + escapeHtml(inst.domain) + '/setup" target="_blank"><button class="btn-primary">Open Setup</button></a>';
          html += '<a href="https://' + escapeHtml(inst.domain) + '/openclaw" target="_blank"><button class="btn-secondary">Open CortexAI</button></a>';
        }
        html += '<button class="btn-muted" onclick="fleetActions.restart(\'' + escapeHtml(inst.id) + '\')">Restart</button>';
        html += '<button class="btn-muted" onclick="fleetActions.redeploy(\'' + escapeHtml(inst.id) + '\')">Redeploy</button>';
        html += '<button class="btn-danger" onclick="fleetActions.remove(\'' + escapeHtml(inst.id) + '\', \'' + escapeHtml(inst.name) + '\')">Delete</button>';
        html += '</div>';

        html += '</div>';
      }
      html += '</div>';

      instancesListEl.innerHTML = html;
    }).catch(function (e) {
      instancesListEl.innerHTML = '<div class="card"><p style="color:#f87171">Error loading instances: ' + escapeHtml(String(e)) + '</p></div>';
    });
  }

  // --- Create tenant ---

  function showCreateTenant() {
    createTenantPanelEl.style.display = '';
    createTenantNameEl.value = '';
    createTenantNotesEl.value = '';
    createTenantNameEl.focus();
  }

  createTenantCancelEl.onclick = function () {
    createTenantPanelEl.style.display = 'none';
  };

  createTenantRunEl.onclick = function () {
    var name = createTenantNameEl.value.trim();
    if (!name) { alert('Enter a tenant name.'); return; }

    createTenantRunEl.disabled = true;

    httpJson('/api/tenants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: name,
        notes: createTenantNotesEl.value.trim() || undefined
      })
    }).then(function (j) {
      if (j.ok) {
        createTenantPanelEl.style.display = 'none';
        loadTenants();
      } else {
        alert('Error: ' + (j.error || 'Unknown error'));
      }
    }).catch(function (e) {
      alert('Error: ' + String(e));
    }).then(function () {
      createTenantRunEl.disabled = false;
    });
  };

  // --- Create instance ---

  function showCreateInstance() {
    createPanelEl.style.display = '';
    createLogEl.style.display = 'none';
    createLogEl.textContent = '';
    createNameEl.value = '';
    createPasswordEl.value = '';
    createNotesEl.value = '';
    createNameEl.focus();
  }

  createCancelEl.onclick = function () {
    createPanelEl.style.display = 'none';
  };

  createRunEl.onclick = function () {
    var name = createNameEl.value.trim();
    if (!name) { alert('Enter an instance name.'); return; }
    if (!currentTenantId) { alert('No tenant selected.'); return; }

    createRunEl.disabled = true;
    createLogEl.style.display = '';
    createLogEl.textContent = 'Creating instance "' + name + '"...\n';

    httpJson('/api/tenants/' + currentTenantId + '/instances', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: name,
        setupPassword: createPasswordEl.value.trim() || undefined,
        notes: createNotesEl.value.trim() || undefined
      })
    }).then(function (j) {
      if (j.log) {
        createLogEl.textContent = j.log.join('\n') + '\n';
      }
      if (j.ok) {
        createLogEl.textContent += '\nInstance created successfully!\n';
        createLogEl.textContent += 'Setup password: ' + (j.instance.setupPassword || '(check dashboard)') + '\n';
        createLogEl.textContent += '\nThe Docker build will take several minutes. Refresh the dashboard to check status.\n';
      } else {
        createLogEl.textContent += '\nError: ' + (j.error || 'Unknown error') + '\n';
      }
      loadInstances(currentTenantId);
    }).catch(function (e) {
      createLogEl.textContent += '\nError: ' + String(e) + '\n';
    }).then(function () {
      createRunEl.disabled = false;
    });
  };

  // --- Global actions ---

  window.fleetActions = {
    showTenants: function () {
      showTenantsView();
    },

    openTenant: function (id, name) {
      showInstancesView(id, name);
    },

    removeTenant: function (id, name, instanceCount) {
      var msg = 'DELETE tenant "' + name + '"?';
      if (instanceCount > 0) {
        msg += '\n\nThis will also delete ' + instanceCount + ' instance(s) and their Railway projects. This cannot be undone.';
      }
      if (!confirm(msg)) return;
      if (instanceCount > 0 && !confirm('Are you absolutely sure? All instances and data will be permanently deleted.')) return;

      httpJson('/api/tenants/' + id, { method: 'DELETE' })
        .then(function () { loadTenants(); })
        .catch(function (e) { alert('Delete error: ' + String(e)); });
    },

    restart: function (id) {
      if (!confirm('Restart this instance? This triggers a redeployment.')) return;
      httpJson('/api/tenants/' + currentTenantId + '/instances/' + id + '/restart', { method: 'POST' })
        .then(function () { loadInstances(currentTenantId); })
        .catch(function (e) { alert('Restart error: ' + String(e)); });
    },

    redeploy: function (id) {
      if (!confirm('Redeploy this instance? This pulls the latest code and rebuilds.')) return;
      httpJson('/api/tenants/' + currentTenantId + '/instances/' + id + '/redeploy', { method: 'POST' })
        .then(function () { loadInstances(currentTenantId); })
        .catch(function (e) { alert('Redeploy error: ' + String(e)); });
    },

    remove: function (id, name) {
      if (!confirm('DELETE instance "' + name + '"?\n\nThis permanently deletes the Railway project, all data, and cannot be undone.')) return;
      if (!confirm('Are you sure? Click OK to proceed with deletion.')) return;

      httpJson('/api/tenants/' + currentTenantId + '/instances/' + id, { method: 'DELETE' })
        .then(function () { loadInstances(currentTenantId); })
        .catch(function (e) { alert('Delete error: ' + String(e)); });
    }
  };

  // --- Refresh ---

  refreshAllEl.onclick = function () {
    if (currentView === 'tenants') {
      loadTenants();
    } else {
      loadInstances(currentTenantId);
    }
  };

  // --- Init ---

  showTenantsView();
})();
