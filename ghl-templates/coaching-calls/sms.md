# Coaching-call SMS copy (GHL)

Same GHL merge fields as the emails. Keep "Reply STOP to opt out" only if your GHL
compliance settings don't already append it. Meeting link comes from the booking
confirmation email (SMS keeps it short).

## Kedma — CFO Consult

**Confirmation**
Hi {{contact.first_name}}, your CFO Consult with Kedma (Ironbooks) is booked for {{appointment.start_time}}. Details + join link are in your email. Need to change it? {{appointment.reschedule_link}}

**24-hour reminder**
Reminder: your CFO Consult with Kedma is tomorrow at {{appointment.start_time}}. Come with your top 2–3 questions on cash flow or margins. Reschedule: {{appointment.reschedule_link}}

**4-hour reminder**
See you soon, {{contact.first_name}} — your CFO Consult with Kedma is today at {{appointment.start_time}}. Join link is in your confirmation email.

## Lisa — CGA Consult

**Confirmation**
Hi {{contact.first_name}}, your CGA Consult with Lisa (Ironbooks) is booked for {{appointment.start_time}}. Details + join link are in your email. Need to change it? {{appointment.reschedule_link}}

**24-hour reminder**
Reminder: your CGA Consult with Lisa is tomorrow at {{appointment.start_time}}. Note any questions about your books or financials. Reschedule: {{appointment.reschedule_link}}

**4-hour reminder**
See you soon, {{contact.first_name}} — your CGA Consult with Lisa is today at {{appointment.start_time}}. Join link is in your confirmation email.
