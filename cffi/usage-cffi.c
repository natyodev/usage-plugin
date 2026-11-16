/*
 * The usage module as a Waybar CFFI module, loaded as `cffi/usage`.
 *
 * Waybar 0.16 gives a custom module click and scroll actions and no hover action. A CFFI module
 * owns its GTK widget, so this one hears the pointer cross it and tells the widget process over
 * D-Bus. What a crossing means is decided there, in widget/controls.ts.
 *
 * It also draws its own text. A GtkLabel centres each line on its advance width, and the side
 * bearings of the glyphs then leave a logo and the percent under it on different centres.
 */

#include <json-glib/json-glib.h>

#include "waybar_cffi_module.h"

const size_t wbcffi_version = 2;

/* Where GApplication exports the actions of widget/main.ts. */
#define WIDGET_BUS_NAME "dev.natyo.UsagePlugin.Widget"
#define WIDGET_OBJECT_PATH "/dev/natyo/UsagePlugin/Widget"

/* Waybar names `custom/usage` #custom-usage, so `cffi/usage` is #cffi-usage. */
#define CSS_NAME "cffi-usage"
#define MODULE_CLASS "module"

typedef struct {
  char* exec;
  char* layout;
  guint interval_seconds;
  guint hover_open_delay_ms;
  guint hover_close_delay_ms;
  gboolean tooltip;
} Config;

typedef struct {
  Config config;
  /* Waybar's event box. It takes the pointer and the clicks, and Waybar sets :hover on its child. */
  GtkWidget* root;
  /* #cffi-usage. A GtkBox applies the margin, padding, min-width and background of the user's CSS. */
  GtkWidget* box;
  GtkWidget* lines;
  PangoLayout* layout;
  char* tooltip;
  /* The classes the last module line set, which the next line replaces. */
  char** classes;
  /* The module run in flight, or NULL. */
  GSubprocess* run;
  /* Cancelled at deinit, so a run that ends later touches nothing. */
  GCancellable* closing;
  guint timer;
  guint watch;
  /* The session bus while the widget owns its name, else NULL. */
  GDBusConnection* widget;
  gboolean pointer_inside;
} Usage;

static JsonNode* config_value(const wbcffi_config_entry* entries, size_t count, const char* key) {
  for (size_t i = 0; i < count; i++) {
    if (g_str_equal(entries[i].key, key)) return json_from_string(entries[i].value, NULL);
  }
  return NULL;
}

static gboolean holds(JsonNode* node, GType type) {
  return node != NULL && JSON_NODE_HOLDS_VALUE(node) && json_node_get_value_type(node) == type;
}

static char* config_string(const wbcffi_config_entry* entries, size_t count, const char* key,
                           const char* fallback) {
  g_autoptr(JsonNode) node = config_value(entries, count, key);
  if (holds(node, G_TYPE_STRING)) return json_node_dup_string(node);
  if (node != NULL) g_warning("usage-plugin: \"%s\" must be a string, using \"%s\"", key, fallback);
  return g_strdup(fallback);
}

static guint config_count(const wbcffi_config_entry* entries, size_t count, const char* key,
                          guint least, guint fallback) {
  g_autoptr(JsonNode) node = config_value(entries, count, key);
  if (holds(node, G_TYPE_INT64) && json_node_get_int(node) >= least && json_node_get_int(node) <= G_MAXINT) {
    return (guint)json_node_get_int(node);
  }
  if (node != NULL) g_warning("usage-plugin: \"%s\" must be a whole number of at least %u, using %u", key, least, fallback);
  return fallback;
}

static void read_config(Config* config, const wbcffi_config_entry* entries, size_t count) {
  config->exec = config_string(entries, count, "exec", "usage-plugin");
  config->layout = config_string(entries, count, "layout", "stacked");
  if (!g_str_equal(config->layout, "stacked") && !g_str_equal(config->layout, "inline")) {
    g_warning("usage-plugin: \"layout\" must be \"stacked\" or \"inline\", using \"stacked\"");
    g_free(config->layout);
    config->layout = g_strdup("stacked");
  }
  config->interval_seconds = config_count(entries, count, "interval", 1, 30);
  config->hover_open_delay_ms = config_count(entries, count, "hover-open-delay", 0, 150);
  config->hover_close_delay_ms = config_count(entries, count, "hover-close-delay", 0, 300);

  g_autoptr(JsonNode) tooltip = config_value(entries, count, "tooltip");
  config->tooltip = holds(tooltip, G_TYPE_BOOLEAN) ? json_node_get_boolean(tooltip) : TRUE;
}

static void measure(Usage* self) {
  PangoRectangle ink, logical;
  pango_layout_get_pixel_extents(self->layout, &ink, &logical);
  gtk_widget_set_size_request(self->lines, MAX(ink.width, logical.width), logical.height);
  gtk_widget_queue_draw(self->lines);
}

static void on_style_updated(GtkWidget* lines, gpointer data) {
  Usage* self = data;
  pango_layout_context_changed(self->layout);
  measure(self);
}

/* Each line goes where the middle of its ink is the middle of the widget. */
static gboolean draw_lines(GtkWidget* lines, cairo_t* cr, gpointer data) {
  Usage* self = data;
  GtkStyleContext* style = gtk_widget_get_style_context(lines);
  GdkRGBA color;
  gtk_style_context_get_color(style, gtk_style_context_get_state(style), &color);
  gdk_cairo_set_source_rgba(cr, &color);

  int height;
  pango_layout_get_pixel_size(self->layout, NULL, &height);
  double centre = gtk_widget_get_allocated_width(lines) / 2.0;
  double top = (gtk_widget_get_allocated_height(lines) - height) / 2.0;

  PangoLayoutIter* iter = pango_layout_get_iter(self->layout);
  do {
    PangoLayoutLine* line = pango_layout_iter_get_line_readonly(iter);
    PangoRectangle ink;
    pango_layout_line_get_extents(line, &ink, NULL);
    double ink_centre = (ink.x + ink.width / 2.0) / PANGO_SCALE;
    cairo_move_to(cr, centre - ink_centre, top + (double)pango_layout_iter_get_baseline(iter) / PANGO_SCALE);
    pango_cairo_show_layout_line(cr, line);
  } while (pango_layout_iter_next_line(iter));
  pango_layout_iter_free(iter);
  return FALSE;
}

static gboolean on_query_tooltip(GtkWidget* box, int x, int y, gboolean keyboard, GtkTooltip* tooltip,
                                 gpointer data) {
  Usage* self = data;
  if (self->tooltip == NULL || self->tooltip[0] == '\0') return FALSE;
  gtk_tooltip_set_markup(tooltip, self->tooltip);
  return TRUE;
}

/* Takes `classes`. Empty text hides the module, as Waybar's custom module does. */
static void show(Usage* self, const char* markup, const char* tooltip, char** classes) {
  PangoAttrList* attributes = NULL;
  g_autofree char* text = NULL;
  g_autoptr(GError) error = NULL;
  if (!pango_parse_markup(markup, -1, 0, &attributes, &text, NULL, &error)) {
    g_warning("usage-plugin: cannot read the module's text as Pango markup: %s", error->message);
    g_strfreev(classes);
    return;
  }
  pango_layout_set_text(self->layout, text, -1);
  pango_layout_set_attributes(self->layout, attributes);
  pango_attr_list_unref(attributes);
  measure(self);

  GtkStyleContext* style = gtk_widget_get_style_context(self->box);
  for (char** name = self->classes; name != NULL && *name != NULL; name++) gtk_style_context_remove_class(style, *name);
  g_strfreev(self->classes);
  self->classes = classes;
  for (char** name = classes; name != NULL && *name != NULL; name++) gtk_style_context_add_class(style, *name);

  g_free(self->tooltip);
  self->tooltip = g_strdup(tooltip);
  gtk_widget_set_visible(self->root, text[0] != '\0');
}

/* The same mark `usage-plugin module` prints when it cannot run. */
static void show_problem(Usage* self, const char* message) {
  g_warning("usage-plugin: %s", message);
  g_autofree char* tooltip = g_markup_printf_escaped("usage-plugin: %s", message);
  show(self, "⚠", tooltip, g_strsplit("broken", " ", -1));
}

static const char* string_member(JsonObject* object, const char* name) {
  JsonNode* node = json_object_get_member(object, name);
  return holds(node, G_TYPE_STRING) ? json_node_get_string(node) : "";
}

/* `class` is one name or a list of names, as in Waybar's custom module. */
static char** classes_of(JsonNode* node) {
  GPtrArray* names = g_ptr_array_new();
  if (holds(node, G_TYPE_STRING)) {
    g_ptr_array_add(names, json_node_dup_string(node));
  } else if (node != NULL && JSON_NODE_HOLDS_ARRAY(node)) {
    JsonArray* array = json_node_get_array(node);
    for (guint i = 0; i < json_array_get_length(array); i++) {
      JsonNode* name = json_array_get_element(array, i);
      if (holds(name, G_TYPE_STRING)) g_ptr_array_add(names, json_node_dup_string(name));
    }
  }
  g_ptr_array_add(names, NULL);
  return (char**)g_ptr_array_free(names, FALSE);
}

static void on_module_line(GObject* source, GAsyncResult* result, gpointer data) {
  g_autofree char* line = NULL;
  g_autoptr(GError) error = NULL;
  gboolean read = g_subprocess_communicate_utf8_finish(G_SUBPROCESS(source), result, &line, NULL, &error);
  if (g_error_matches(error, G_IO_ERROR, G_IO_ERROR_CANCELLED)) return;

  Usage* self = data;
  g_clear_object(&self->run);
  if (!read) return show_problem(self, error->message);

  g_autoptr(JsonNode) root = json_from_string(line, NULL);
  if (root == NULL || !JSON_NODE_HOLDS_OBJECT(root)) {
    return show_problem(self, "the module printed something other than one JSON object");
  }
  JsonObject* output = json_node_get_object(root);
  show(self, string_member(output, "text"), string_member(output, "tooltip"),
       classes_of(json_object_get_member(output, "class")));
}

static void run_module(Usage* self) {
  if (self->run != NULL) {
    /* It outlived a whole interval, so it is stuck. Its end frees the slot for the next tick. */
    g_subprocess_force_exit(self->run);
    return;
  }
  g_autoptr(GError) error = NULL;
  self->run = g_subprocess_new(G_SUBPROCESS_FLAGS_STDOUT_PIPE, &error, self->config.exec, "module", "--layout",
                               self->config.layout, NULL);
  if (self->run == NULL) return show_problem(self, error->message);
  g_subprocess_communicate_utf8_async(self->run, NULL, self->closing, on_module_line, self);
}

static gboolean on_tick(gpointer data) {
  run_module(data);
  return G_SOURCE_CONTINUE;
}

/* `--serve` does nothing when a widget already runs, so this is safe to repeat. */
static void start_widget(Usage* self, const char* how) {
  g_autoptr(GError) error = NULL;
  g_autoptr(GSubprocess) launcher =
      g_subprocess_new(G_SUBPROCESS_FLAGS_NONE, &error, self->config.exec, "widget", how, NULL);
  if (launcher == NULL) g_warning("usage-plugin: cannot start the widget: %s", error->message);
}

/* Takes a floating `parameter`, or NULL for an action that has none. */
static void tell_widget(Usage* self, const char* action, GVariant* parameter) {
  GVariantBuilder parameters;
  g_variant_builder_init(&parameters, G_VARIANT_TYPE("av"));
  if (parameter != NULL) g_variant_builder_add(&parameters, "v", parameter);
  g_dbus_connection_call(self->widget, WIDGET_BUS_NAME, WIDGET_OBJECT_PATH, "org.gtk.Actions", "Activate",
                         g_variant_new("(sava{sv})", action, &parameters, NULL), NULL,
                         G_DBUS_CALL_FLAGS_NO_AUTO_START, -1, NULL, NULL, NULL);
}

static GVariant* hover_timing(Usage* self) {
  return g_variant_new("(uu)", self->config.hover_open_delay_ms, self->config.hover_close_delay_ms);
}

static void on_widget_appeared(GDBusConnection* bus, const char* name, const char* owner, gpointer data) {
  Usage* self = data;
  g_set_object(&self->widget, bus);
  if (self->pointer_inside) tell_widget(self, "module-enter", hover_timing(self));
}

static void on_widget_vanished(GDBusConnection* bus, const char* name, gpointer data) {
  Usage* self = data;
  g_clear_object(&self->widget);
}

static gboolean on_enter(GtkWidget* root, GdkEventCrossing* event, gpointer data) {
  Usage* self = data;
  if (event->detail == GDK_NOTIFY_INFERIOR) return FALSE;
  self->pointer_inside = TRUE;
  if (self->widget != NULL) {
    tell_widget(self, "module-enter", hover_timing(self));
  } else {
    start_widget(self, "--serve");
  }
  return FALSE;
}

static gboolean on_leave(GtkWidget* root, GdkEventCrossing* event, gpointer data) {
  Usage* self = data;
  if (event->detail == GDK_NOTIFY_INFERIOR) return FALSE;
  self->pointer_inside = FALSE;
  if (self->widget != NULL) tell_widget(self, "module-leave", hover_timing(self));
  return FALSE;
}

/* Reached only when the config has no `on-click`. Waybar runs one and then stops the event. */
static gboolean on_press(GtkWidget* root, GdkEventButton* event, gpointer data) {
  Usage* self = data;
  if (event->type != GDK_BUTTON_PRESS || event->button != GDK_BUTTON_PRIMARY) return FALSE;
  if (self->widget != NULL) {
    tell_widget(self, "module-click", NULL);
  } else {
    start_widget(self, "--toggle");
  }
  return TRUE;
}

void* wbcffi_init(const wbcffi_init_info* init_info, const wbcffi_config_entry* config_entries,
                  size_t config_entries_len) {
  Usage* self = g_new0(Usage, 1);
  read_config(&self->config, config_entries, config_entries_len);
  self->closing = g_cancellable_new();
  self->root = GTK_WIDGET(init_info->get_root_widget(init_info->obj));

  self->box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
  gtk_widget_set_name(self->box, CSS_NAME);
  gtk_style_context_add_class(gtk_widget_get_style_context(self->box), MODULE_CLASS);
  if (self->config.tooltip) {
    gtk_widget_set_has_tooltip(self->box, TRUE);
    g_signal_connect(self->box, "query-tooltip", G_CALLBACK(on_query_tooltip), self);
  }

  self->lines = gtk_drawing_area_new();
  self->layout = gtk_widget_create_pango_layout(self->lines, NULL);
  g_signal_connect(self->lines, "draw", G_CALLBACK(draw_lines), self);
  g_signal_connect(self->lines, "style-updated", G_CALLBACK(on_style_updated), self);
  gtk_box_pack_start(GTK_BOX(self->box), self->lines, TRUE, TRUE, 0);
  gtk_container_add(GTK_CONTAINER(self->root), self->box);
  gtk_widget_show_all(self->box);

  g_signal_connect(self->root, "enter-notify-event", G_CALLBACK(on_enter), self);
  g_signal_connect(self->root, "leave-notify-event", G_CALLBACK(on_leave), self);
  /* Waybar's click handler runs after the default one, and this has to run after Waybar's. */
  g_signal_connect_after(self->root, "button-press-event", G_CALLBACK(on_press), self);

  self->watch = g_bus_watch_name(G_BUS_TYPE_SESSION, WIDGET_BUS_NAME, G_BUS_NAME_WATCHER_FLAGS_NONE,
                                 on_widget_appeared, on_widget_vanished, self, NULL);
  /* Started with the bar, so the first hover finds the widget already running. */
  start_widget(self, "--serve");

  run_module(self);
  self->timer = g_timeout_add_seconds(self->config.interval_seconds, on_tick, self);
  return self;
}

void wbcffi_deinit(void* instance) {
  Usage* self = instance;
  g_source_remove(self->timer);
  g_bus_unwatch_name(self->watch);
  g_cancellable_cancel(self->closing);
  g_signal_handlers_disconnect_by_data(self->root, self);
  gtk_widget_destroy(self->box);

  g_clear_object(&self->run);
  g_clear_object(&self->closing);
  g_clear_object(&self->widget);
  g_clear_object(&self->layout);
  g_strfreev(self->classes);
  g_free(self->tooltip);
  g_free(self->config.exec);
  g_free(self->config.layout);
  g_free(self);
}
